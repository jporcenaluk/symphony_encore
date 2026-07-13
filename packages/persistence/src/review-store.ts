import { isReviewResult, type ReviewResult } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { finishAttemptInTransaction } from "./finish-attempt.js";

type WorkRef = { id: string; kind: "issue" | "system_job" };

interface PendingReviewRow {
  base_sha: string;
  change_class: "standard" | "high_risk";
  config_snapshot_id: string;
  implementation_attempt_id: string;
  target_sha: string;
  verification_record_id: string;
  workspace_path: string;
}

export interface PendingIntegrativeReview {
  baseSha: string;
  changeClass: "standard" | "high_risk";
  configSnapshotId: string;
  implementationAttemptId: string;
  targetSha: string;
  verificationRecordId: string;
  workspacePath: string;
}

export async function loadPendingIntegrativeReview(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingIntegrativeReview | null> {
  const result = await sql<PendingReviewRow>`
    select checkout.base_sha, implementation.change_class,
           verification.config_snapshot_id, implementation.id as implementation_attempt_id,
           verification.target_revision as target_sha,
           verification.id as verification_record_id, checkout.workspace_path
    from claims claim
    join attempts implementation
      on implementation.work_ref_kind = claim.work_ref_kind
      and implementation.work_ref_id = claim.work_ref_id
      and implementation.role = 'implementation'
      and implementation.status = 'closed'
      and implementation.change_class in ('standard', 'high_risk')
    join verification_records verification
      on verification.attempt_id = implementation.id
      and verification.work_ref_kind = claim.work_ref_kind
      and verification.work_ref_id = claim.work_ref_id
      and verification.result = 'passed'
      and verification.exit_code = 0
    join workspace_checkouts checkout
      on checkout.work_ref_kind = claim.work_ref_kind
      and checkout.work_ref_id = claim.work_ref_id
      and checkout.workspace_path = implementation.workspace_path
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = 'review_required'
    order by implementation.attempt_number desc, verification.ended_at desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row
    ? {
        baseSha: row.base_sha,
        changeClass: row.change_class,
        configSnapshotId: row.config_snapshot_id,
        implementationAttemptId: row.implementation_attempt_id,
        targetSha: row.target_sha,
        verificationRecordId: row.verification_record_id,
        workspacePath: row.workspace_path,
      }
    : null;
}

export interface FinishReviewAttemptInput {
  attemptId: string;
  costUsd: number | null;
  endedAt: string;
  patchIdentity: string;
  reservationId: string;
  result: ReviewResult;
  reviewRecordId: string;
  settledLedgers: readonly { actualAmount: number; id: string }[];
  targetBaseSha: string;
  targetSha: string;
  terminalResultId: string;
  usage: { inputTokens: number; outputTokens: number };
  workRef: WorkRef;
}

export async function finishReviewAttempt(
  database: Kysely<DatabaseSchema>,
  input: FinishReviewAttemptInput,
): Promise<void> {
  validateFinishInput(input);
  await database.transaction().execute(async (transaction) => {
    const target = await sql`
      select verification.id
      from attempts review
      join verification_records verification
        on verification.work_ref_kind = review.work_ref_kind
        and verification.work_ref_id = review.work_ref_id
        and verification.target_revision = ${input.targetSha}
        and verification.result = 'passed'
        and verification.exit_code = 0
      join workspace_checkouts checkout
        on checkout.work_ref_kind = review.work_ref_kind
        and checkout.work_ref_id = review.work_ref_id
        and checkout.workspace_path = review.workspace_path
        and checkout.base_sha = ${input.targetBaseSha}
      where review.id = ${input.attemptId}
        and review.work_ref_kind = ${input.workRef.kind}
        and review.work_ref_id = ${input.workRef.id}
        and review.role = 'integrative_review'
        and review.status != 'closed'
      limit 1
    `.execute(transaction);
    if (target.rows.length !== 1) throw new Error("review.verified_target_missing");
    await sql`
      insert into review_records (
        id, work_ref_kind, work_ref_id, attempt_id, reviewer_role, target_sha,
        target_base_sha, patch_identity, decision, findings_json, created_at
      ) values (
        ${input.reviewRecordId}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
        'integrative_review', ${input.targetSha}, ${input.targetBaseSha}, ${input.patchIdentity},
        ${input.result.decision}, ${JSON.stringify(input.result.findings)}, ${input.endedAt}
      )
    `.execute(transaction);
    await finishAttemptInTransaction(transaction, {
      attemptId: input.attemptId,
      costUsd: input.costUsd,
      endedAt: input.endedAt,
      failureClass: null,
      nextClaim: { mode: "Ready", reason: "review_coordination_required" },
      reservationId: input.reservationId,
      settledLedgers: input.settledLedgers,
      terminalResult: {
        id: input.terminalResultId,
        kind: "review_result",
        payload: input.result,
        role: "integrative_review",
      },
      usage: input.usage,
      workRef: input.workRef,
    });
  });
}

function validateFinishInput(input: FinishReviewAttemptInput): void {
  if (
    !input.attemptId ||
    !input.patchIdentity ||
    !input.reviewRecordId ||
    !input.targetBaseSha ||
    !input.targetSha ||
    !input.terminalResultId ||
    !isReviewResult(input.result)
  ) {
    throw new Error("review.finish_input_invalid");
  }
  if (input.result.target_sha !== input.targetSha) {
    throw new Error("review.target_sha_mismatch");
  }
}
