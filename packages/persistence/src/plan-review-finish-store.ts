import { isPlanReviewResult, type PlanReviewResult } from "@symphony/contracts";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { finishAttemptInTransaction } from "./finish-attempt.js";

export interface FinishPlanReviewAttemptInput {
  attemptId: string;
  costUsd: number | null;
  endedAt: string;
  maxPlanRevisions: number;
  planId: string;
  questionId: string | null;
  reservationId: string;
  result: PlanReviewResult;
  settledLedgers: readonly { actualAmount: number; id: string }[];
  terminalResultId: string;
  usage: { inputTokens: number; outputTokens: number };
  workRef: { id: string; kind: "issue" | "system_job" };
}

interface ReviewedPlanRow {
  revision: number;
}

interface StoredPlanReviewResultRow {
  attempt_id: string;
  payload_json: string;
}

export async function loadLatestPlanReviewResult(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<{ attemptId: string; result: PlanReviewResult } | null> {
  const query = await sql<StoredPlanReviewResultRow>`
    select result.attempt_id, result.payload_json
    from terminal_results result
    join attempts attempt on attempt.id = result.attempt_id
    where attempt.work_ref_kind = ${workRef.kind}
      and attempt.work_ref_id = ${workRef.id}
      and attempt.role = 'plan_review'
      and attempt.status = 'closed'
      and result.role = 'plan_review'
      and result.result_kind = 'plan_review_result'
    order by attempt.attempt_number desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  if (!row) return null;
  const result: unknown = JSON.parse(row.payload_json);
  if (!isPlanReviewResult(result)) {
    throw new Error("plan_review.persisted_result_invalid");
  }
  return { attemptId: row.attempt_id, result };
}

export async function finishPlanReviewAttempt(
  database: Kysely<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
): Promise<void> {
  validateInput(input);
  await database.transaction().execute(async (transaction) => {
    const plan = await loadReviewedPlan(transaction, input);
    if (plan.revision !== input.result.plan_revision) {
      throw new Error("plan_review.plan_revision_mismatch");
    }
    const nextClaim = await applyDecision(transaction, input);
    await finishAttemptInTransaction(transaction, {
      attemptId: input.attemptId,
      costUsd: input.costUsd,
      endedAt: input.endedAt,
      failureClass: null,
      nextClaim,
      reservationId: input.reservationId,
      settledLedgers: input.settledLedgers,
      terminalResult: {
        id: input.terminalResultId,
        kind: "plan_review_result",
        payload: input.result,
        role: "plan_review",
      },
      usage: input.usage,
      workRef: input.workRef,
    });
  });
}

function validateInput(input: FinishPlanReviewAttemptInput): void {
  if (
    !input.attemptId ||
    !input.planId ||
    !input.terminalResultId ||
    !Number.isInteger(input.maxPlanRevisions) ||
    input.maxPlanRevisions < 1
  ) {
    throw new Error("plan_review.finish_input_invalid");
  }
  if ((input.result.decision === "needs_input") !== Boolean(input.questionId)) {
    throw new Error("plan_review.question_identity_invalid");
  }
}

async function loadReviewedPlan(
  transaction: Transaction<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
): Promise<ReviewedPlanRow> {
  const result = await sql<ReviewedPlanRow>`
    select revision from plans
    where id = ${input.planId}
      and work_ref_kind = ${input.workRef.kind}
      and work_ref_id = ${input.workRef.id}
      and status = 'validated'
      and validated_at is not null
  `.execute(transaction);
  const plan = result.rows[0];
  if (!plan) throw new Error("plan_review.validated_plan_missing");
  return plan;
}

async function applyDecision(
  transaction: Transaction<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
): Promise<
  | { mode: "Ready"; reason: string }
  | {
      approvalRequestId: null;
      blockerPredicate: null;
      mode: "AwaitingHuman";
      questionId: string | null;
      reason: string;
    }
> {
  if (input.result.decision === "approve") {
    await updatePlan(transaction, input, "approved");
    return { mode: "Ready", reason: "implementation_after_plan_approval" };
  }

  await updatePlan(transaction, input, "rejected");
  if (input.result.decision === "needs_input") {
    const questionId = input.questionId as string;
    await insertQuestion(transaction, input, questionId);
    await parkWork(transaction, input, "needs_input", questionId);
    return awaitingHuman("needs_input", questionId);
  }

  const rejected = await rejectedRevisionCount(transaction, input.workRef);
  if (rejected >= input.maxPlanRevisions) {
    await parkWork(transaction, input, "human_review", null);
    return awaitingHuman("human_review", null);
  }
  return { mode: "Ready", reason: "plan_revision_required" };
}

async function updatePlan(
  transaction: Transaction<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
  status: "approved" | "rejected",
): Promise<void> {
  const update = await sql`
    update plans
    set status = ${status},
        approved_by_attempt_id = ${status === "approved" ? input.attemptId : null}
    where id = ${input.planId} and status = 'validated'
  `.execute(transaction);
  if (update.numAffectedRows !== 1n) throw new Error("plan_review.plan_update_conflict");
}

async function rejectedRevisionCount(
  transaction: Transaction<DatabaseSchema>,
  workRef: FinishPlanReviewAttemptInput["workRef"],
): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*) as count from plans
    where work_ref_kind = ${workRef.kind}
      and work_ref_id = ${workRef.id}
      and status = 'rejected'
  `.execute(transaction);
  return result.rows[0]?.count ?? 0;
}

async function insertQuestion(
  transaction: Transaction<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
  questionId: string,
): Promise<void> {
  if (input.result.decision !== "needs_input") {
    throw new Error("plan_review.question_decision_invalid");
  }
  const question = input.result.question;
  await sql`
    insert into operator_questions (
      id, work_ref_kind, work_ref_id, attempt_id, text, options_json,
      default_answer, comment_marker, comment_cursor, asked_at,
      reminded_at, answered_at, answer, answered_by
    ) values (
      ${questionId}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
      ${question.text}, ${JSON.stringify(question.options)}, ${question.default},
      ${`<!-- symphony-question:${questionId} -->`}, null, ${input.endedAt},
      null, null, null, null
    )
  `.execute(transaction);
}

async function parkWork(
  transaction: Transaction<DatabaseSchema>,
  input: FinishPlanReviewAttemptInput,
  reason: "human_review" | "needs_input",
  questionId: string | null,
): Promise<void> {
  await sql`
    insert into parked_work (
      work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
      question_id, parked_at, last_checked_at, resolved_at
    ) values (
      ${input.workRef.kind}, ${input.workRef.id}, 'In Progress', ${reason}, null,
      ${questionId}, ${input.endedAt}, ${input.endedAt}, null
    )
    on conflict(work_ref_kind, work_ref_id) do update set
      origin_stage = excluded.origin_stage,
      reason = excluded.reason,
      blocker_predicate = null,
      question_id = excluded.question_id,
      parked_at = excluded.parked_at,
      last_checked_at = excluded.last_checked_at,
      resolved_at = null
  `.execute(transaction);
}

function awaitingHuman(reason: string, questionId: string | null) {
  return {
    approvalRequestId: null,
    blockerPredicate: null,
    mode: "AwaitingHuman" as const,
    questionId,
    reason,
  };
}
