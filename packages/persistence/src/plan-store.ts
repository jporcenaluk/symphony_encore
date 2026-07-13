import { isPlan, type Plan } from "@symphony/contracts";
import type { ChangeClass } from "@symphony/domain";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface AttemptIdentityRow {
  role: string;
  status: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

export async function recordSubmittedPlan(
  database: Kysely<DatabaseSchema>,
  input: { attemptId: string; plan: unknown },
): Promise<{ replayed: boolean }> {
  const plan = input.plan;
  if (!isPlan(plan)) throw new Error("plan.invalid");
  if (
    plan.status !== "draft" ||
    plan.validated_at !== null ||
    plan.approved_by_attempt_id !== null
  ) {
    throw new Error("plan.submission_state_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const attempts = await sql<AttemptIdentityRow>`
      select role, status, work_ref_kind, work_ref_id
      from attempts where id = ${input.attemptId}
    `.execute(transaction);
    const attempt = attempts.rows[0];
    if (attempt?.role !== "implementation" || attempt.status !== "running") {
      throw new Error("plan.running_implementation_attempt_missing");
    }
    const workRef = planWorkRef(plan);
    if (
      plan.created_by_attempt_id !== input.attemptId ||
      workRef.kind !== attempt.work_ref_kind ||
      workRef.id !== attempt.work_ref_id
    ) {
      throw new Error("plan.attempt_work_ref_mismatch");
    }
    const existing = await sql<StoredPlanRow>`
      select * from plans where id = ${plan.id}
    `.execute(transaction);
    const original = existing.rows[0];
    if (original) {
      if (submissionFingerprintFromRow(original) !== submissionFingerprint(plan)) {
        throw new Error("plan.idempotency_conflict");
      }
      return { replayed: true };
    }
    const current = await sql<{ maximum: number | null }>`
      select max(revision) as maximum
      from plans
      where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
    `.execute(transaction);
    if (plan.revision !== (current.rows[0]?.maximum ?? 0) + 1) {
      throw new Error("plan.revision_not_next");
    }
    await sql`
      update plans set status = 'superseded'
      where work_ref_kind = ${workRef.kind}
        and work_ref_id = ${workRef.id}
        and status in ('draft', 'validated')
    `.execute(transaction);
    await sql`
      insert into plans (
        id, work_ref_kind, work_ref_id, revision, status, approach,
        acceptance_criteria_json, proposed_paths_json, verification_commands_json,
        estimated_files, estimated_changed_lines, risk_facts_json,
        created_by_attempt_id, created_at, validated_at, approved_by_attempt_id
      ) values (
        ${plan.id}, ${workRef.kind}, ${workRef.id}, ${plan.revision},
        ${plan.status}, ${plan.approach},
        ${JSON.stringify(plan.acceptance_criteria)},
        ${JSON.stringify(plan.proposed_paths)},
        ${JSON.stringify(plan.verification_commands)},
        ${plan.estimated_files}, ${plan.estimated_changed_lines},
        ${JSON.stringify(plan.risk_facts)}, ${plan.created_by_attempt_id},
        ${plan.created_at}, ${plan.validated_at}, ${plan.approved_by_attempt_id}
      )
    `.execute(transaction);
    return { replayed: false };
  });
}

interface StoredPlanRow {
  acceptance_criteria_json: string;
  approach: string;
  approved_by_attempt_id: string | null;
  created_at: string;
  created_by_attempt_id: string;
  estimated_changed_lines: number;
  estimated_files: number;
  id: string;
  proposed_paths_json: string;
  revision: number;
  risk_facts_json: string;
  status: Plan["status"];
  validated_at: string | null;
  verification_commands_json: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

export async function loadLatestValidatedPlan(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<Plan | null> {
  const result = await sql<StoredPlanRow>`
    select * from plans
    where work_ref_kind = ${workRef.kind}
      and work_ref_id = ${workRef.id}
      and status = 'validated'
      and validated_at is not null
    order by revision desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  if (!row) return null;
  const plan = {
    acceptance_criteria: JSON.parse(row.acceptance_criteria_json),
    approach: row.approach,
    approved_by_attempt_id: row.approved_by_attempt_id,
    created_at: row.created_at,
    created_by_attempt_id: row.created_by_attempt_id,
    estimated_changed_lines: row.estimated_changed_lines,
    estimated_files: row.estimated_files,
    id: row.id,
    proposed_paths: JSON.parse(row.proposed_paths_json),
    revision: row.revision,
    risk_facts: JSON.parse(row.risk_facts_json),
    status: row.status,
    validated_at: row.validated_at,
    verification_commands: JSON.parse(row.verification_commands_json),
    work_ref:
      row.work_ref_kind === "issue"
        ? { issue_id: row.work_ref_id }
        : { system_job_id: row.work_ref_id },
  };
  if (!isPlan(plan)) throw new Error("plan.persisted_record_invalid");
  return plan;
}

export async function markPlanValidated(
  database: Kysely<DatabaseSchema>,
  input: { attemptId: string; planId: string; validatedAt: string },
): Promise<void> {
  const update = await sql`
    update plans
    set status = 'validated', validated_at = ${input.validatedAt}
    where id = ${input.planId}
      and created_by_attempt_id = ${input.attemptId}
      and status = 'draft'
      and validated_at is null
  `.execute(database);
  if (update.numAffectedRows === 1n) return;
  const existing = await sql<{
    created_by_attempt_id: string;
    status: string;
    validated_at: string | null;
  }>`
    select created_by_attempt_id, status, validated_at
    from plans where id = ${input.planId}
  `.execute(database);
  const plan = existing.rows[0];
  if (
    plan?.created_by_attempt_id === input.attemptId &&
    plan.status === "validated" &&
    plan.validated_at !== null
  ) {
    return;
  }
  throw new Error("plan.validation_state_conflict");
}

interface ClassificationTargetRow {
  change_class: ChangeClass;
  plan_status: string;
  routing_reasons_json: string;
  status: string;
  validated_at: string | null;
}

export async function loadAttemptPlanGateState(
  database: Kysely<DatabaseSchema>,
  attemptId: string,
): Promise<{ changeClass: ChangeClass; validatedPlan: boolean }> {
  const result = await sql<{ change_class: ChangeClass; validated_plan: number }>`
    select attempt.change_class,
      exists(
        select 1 from plans plan
        where plan.created_by_attempt_id = attempt.id
          and plan.status = 'validated'
          and plan.validated_at is not null
      ) as validated_plan
    from attempts attempt
    where attempt.id = ${attemptId}
      and attempt.role = 'implementation'
      and attempt.status = 'running'
  `.execute(database);
  const row = result.rows[0];
  if (!row) throw new Error("plan.gate_attempt_missing");
  return { changeClass: row.change_class, validatedPlan: row.validated_plan === 1 };
}

export async function recordAuthoritativePlanClassification(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    changeClass: ChangeClass;
    expectedProvisionalClass: ChangeClass;
    planId: string;
    reasons: readonly string[];
    validatedAt: string;
  },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const targets = await sql<ClassificationTargetRow>`
      select attempt.change_class, attempt.routing_reasons_json, attempt.status,
             plan.status as plan_status, plan.validated_at
      from attempts attempt
      join plans plan
        on plan.id = ${input.planId}
        and plan.created_by_attempt_id = attempt.id
      where attempt.id = ${input.attemptId}
        and attempt.role = 'implementation'
    `.execute(transaction);
    const target = targets.rows[0];
    if (
      target?.status === "running" &&
      target.plan_status === "validated" &&
      target.validated_at !== null &&
      target.change_class === input.changeClass
    ) {
      return;
    }
    if (
      target?.status !== "running" ||
      target.change_class !== input.expectedProvisionalClass ||
      (target.plan_status !== "draft" && target.plan_status !== "validated") ||
      (target.change_class === "high_risk" && input.changeClass !== "high_risk")
    ) {
      throw new Error("plan.authoritative_class_conflict");
    }
    const existingReasons = JSON.parse(target.routing_reasons_json) as unknown;
    if (
      !Array.isArray(existingReasons) ||
      existingReasons.some((reason) => typeof reason !== "string")
    ) {
      throw new Error("plan.routing_reasons_corrupt");
    }
    const reasons = [...new Set([...existingReasons, ...input.reasons])];
    if (target.plan_status === "draft") {
      const planUpdate = await sql`
        update plans
        set status = 'validated', validated_at = ${input.validatedAt}
        where id = ${input.planId} and status = 'draft' and validated_at is null
      `.execute(transaction);
      if (planUpdate.numAffectedRows !== 1n) {
        throw new Error("plan.validation_state_conflict");
      }
    }
    const update = await sql`
      update attempts
      set change_class = ${input.changeClass}, routing_reasons_json = ${JSON.stringify(reasons)}
      where id = ${input.attemptId} and change_class = ${input.expectedProvisionalClass}
    `.execute(transaction);
    if (update.numAffectedRows !== 1n) throw new Error("plan.authoritative_class_conflict");
  });
}

function submissionFingerprint(plan: Plan): string {
  const workRef = planWorkRef(plan);
  return JSON.stringify({
    acceptanceCriteria: plan.acceptance_criteria,
    approach: plan.approach,
    createdAt: plan.created_at,
    createdByAttemptId: plan.created_by_attempt_id,
    estimatedChangedLines: plan.estimated_changed_lines,
    estimatedFiles: plan.estimated_files,
    id: plan.id,
    proposedPaths: plan.proposed_paths,
    revision: plan.revision,
    riskFacts: plan.risk_facts,
    verificationCommands: plan.verification_commands,
    workRefId: workRef.id,
    workRefKind: workRef.kind,
  });
}

function submissionFingerprintFromRow(plan: StoredPlanRow): string {
  return JSON.stringify({
    acceptanceCriteria: JSON.parse(plan.acceptance_criteria_json),
    approach: plan.approach,
    createdAt: plan.created_at,
    createdByAttemptId: plan.created_by_attempt_id,
    estimatedChangedLines: plan.estimated_changed_lines,
    estimatedFiles: plan.estimated_files,
    id: plan.id,
    proposedPaths: JSON.parse(plan.proposed_paths_json),
    revision: plan.revision,
    riskFacts: JSON.parse(plan.risk_facts_json),
    verificationCommands: JSON.parse(plan.verification_commands_json),
    workRefId: plan.work_ref_id,
    workRefKind: plan.work_ref_kind,
  });
}

function planWorkRef(plan: Plan): { id: string; kind: "issue" | "system_job" } {
  return "issue_id" in plan.work_ref
    ? { id: plan.work_ref.issue_id, kind: "issue" }
    : { id: plan.work_ref.system_job_id, kind: "system_job" };
}
