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
): Promise<void> {
  const plan = input.plan;
  if (!isPlan(plan)) throw new Error("plan.invalid");
  if (
    plan.status !== "draft" ||
    plan.validated_at !== null ||
    plan.approved_by_attempt_id !== null
  ) {
    throw new Error("plan.submission_state_invalid");
  }
  await database.transaction().execute(async (transaction) => {
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
  });
}

function planWorkRef(plan: Plan): { id: string; kind: "issue" | "system_job" } {
  return "issue_id" in plan.work_ref
    ? { id: plan.work_ref.issue_id, kind: "issue" }
    : { id: plan.work_ref.system_job_id, kind: "system_job" };
}
