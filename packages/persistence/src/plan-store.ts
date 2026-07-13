import { isPlan, type Plan } from "@symphony/contracts";
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
  created_at: string;
  created_by_attempt_id: string;
  estimated_changed_lines: number;
  estimated_files: number;
  id: string;
  proposed_paths_json: string;
  revision: number;
  risk_facts_json: string;
  verification_commands_json: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
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
