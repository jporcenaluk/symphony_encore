import {
  type AdjudicationResult,
  isReviewRecord,
  isReviewResult,
  type ReviewRecord,
  type ReviewResult,
  validateAdjudicationResult,
} from "@symphony/contracts";
import {
  decideReviewSet,
  findContraryReviewFindings,
  type ReviewConflict,
  type ReviewRecordSummary,
} from "@symphony/domain";
import { type Kysely, sql, type Transaction } from "kysely";

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

export interface PendingReviewCoordination {
  changeClass: "standard" | "high_risk";
  patchIdentity: string;
  proposedPaths: readonly string[];
  rejectedFindingIds: readonly string[];
  records: readonly {
    decision: ReviewRecord["decision"];
    findings: ReviewRecord["findings"];
    id: string;
    reviewer: string;
    reviewerRole: ReviewRecord["reviewer_role"];
    targetSha: string;
  }[];
  riskFacts: readonly string[];
  targetBaseSha: string;
  targetSha: string;
  unresolvedBlockingFindingIds: readonly string[];
  verificationRecordId: string;
  workspacePath: string;
}

interface CoordinationTargetRow {
  change_class: PendingReviewCoordination["changeClass"];
  patch_identity: string;
  proposed_paths_json: string;
  risk_facts_json: string;
  target_base_sha: string;
  target_sha: string;
  verification_record_id: string;
  workspace_path: string;
}

interface CoordinationRecordRow {
  attempt_id: string;
  created_at: string;
  decision: ReviewRecord["decision"];
  findings_json: string;
  id: string;
  patch_identity: string;
  reviewer_role: ReviewRecord["reviewer_role"];
  routing_reasons_json: string;
  target_base_sha: string;
  target_sha: string;
}

interface AdjudicationResultRow {
  payload_json: string;
}

interface ReviewSetFindingsRow {
  unresolved_blocking_finding_ids_json: string;
}

export async function loadPendingReviewCoordination(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingReviewCoordination | null> {
  const targets = await sql<CoordinationTargetRow>`
    select attempt.change_class, record.patch_identity, record.target_base_sha,
           record.target_sha, verification.id as verification_record_id,
           implementation.routing_reasons_json as risk_facts_json,
           plan.proposed_paths_json, attempt.workspace_path
    from claims claim
    join review_records record
      on record.work_ref_kind = claim.work_ref_kind
      and record.work_ref_id = claim.work_ref_id
      and record.reviewer_role = 'integrative_review'
    join attempts attempt on attempt.id = record.attempt_id and attempt.status = 'closed'
    join verification_records verification
      on verification.work_ref_kind = claim.work_ref_kind
      and verification.work_ref_id = claim.work_ref_id
      and verification.target_revision = record.target_sha
      and verification.result = 'passed'
      and verification.exit_code = 0
    join attempts implementation
      on implementation.id = verification.attempt_id
      and implementation.role = 'implementation'
      and implementation.status = 'closed'
    join plans plan
      on plan.work_ref_kind = claim.work_ref_kind
      and plan.work_ref_id = claim.work_ref_id
      and plan.revision = (
        select max(latest.revision) from plans latest
        where latest.work_ref_kind = claim.work_ref_kind
          and latest.work_ref_id = claim.work_ref_id
      )
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and (
        (claim.mode = 'Ready' and (
          claim.reason = 'review_coordination_required'
          or claim.reason like 'specialist_review_required:%'
          or claim.reason = 'adjudication_required'
          or claim.reason = 'review_rework'
        ))
        or (claim.mode = 'Running' and claim.reason = 'adjudication')
      )
    order by attempt.attempt_number desc, verification.ended_at desc
    limit 1
  `.execute(database);
  const target = targets.rows[0];
  if (!target) return null;
  const riskFacts = parseStringList(target.risk_facts_json, "review.persisted_risk_facts_invalid");
  const proposedPaths = parseStringList(
    target.proposed_paths_json,
    "review.persisted_proposed_paths_invalid",
  );
  const records = await sql<CoordinationRecordRow>`
    select record.*, attempt.routing_reasons_json
    from review_records record
    join attempts attempt on attempt.id = record.attempt_id and attempt.status = 'closed'
    where record.work_ref_kind = ${workRef.kind}
      and record.work_ref_id = ${workRef.id}
      and record.target_sha = ${target.target_sha}
      and record.target_base_sha = ${target.target_base_sha}
      and record.patch_identity = ${target.patch_identity}
    order by attempt.attempt_number
  `.execute(database);
  const rejectedFindingIds = await loadRejectedFindingIds(database, workRef, target.target_sha);
  const unresolvedBlockingFindingIds = await loadUnresolvedBlockingFindingIds(
    database,
    workRef,
    target.target_sha,
    target.patch_identity,
  );
  return {
    changeClass: target.change_class,
    patchIdentity: target.patch_identity,
    proposedPaths,
    rejectedFindingIds,
    records: records.rows.map((row) => coordinationRecord(row, workRef)),
    targetBaseSha: target.target_base_sha,
    targetSha: target.target_sha,
    unresolvedBlockingFindingIds,
    riskFacts,
    verificationRecordId: target.verification_record_id,
    workspacePath: target.workspace_path,
  };
}

async function loadUnresolvedBlockingFindingIds(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  workRef: WorkRef,
  targetSha: string,
  patchIdentity: string,
): Promise<string[]> {
  const query = await sql<ReviewSetFindingsRow>`
    select unresolved_blocking_finding_ids_json
    from review_sets
    where work_ref_kind = ${workRef.kind}
      and work_ref_id = ${workRef.id}
      and target_sha = ${targetSha}
      and patch_identity = ${patchIdentity}
    order by created_at desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  return row
    ? parseStringList(
        row.unresolved_blocking_finding_ids_json,
        "review.persisted_unresolved_findings_invalid",
      )
    : [];
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
  reviewerRole: "integrative_review" | "specialist_review";
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
        and review.role = ${input.reviewerRole}
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
        ${input.reviewerRole}, ${input.targetSha}, ${input.targetBaseSha}, ${input.patchIdentity},
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
        role: input.reviewerRole,
      },
      usage: input.usage,
      workRef: input.workRef,
    });
  });
}

export async function commitOrdinaryReviewSet(
  database: Kysely<DatabaseSchema>,
  input: {
    createdAt: string;
    id: string;
    requiredSpecialistNames: readonly string[];
    workRef: WorkRef;
  },
): Promise<{ decision: ReviewRecord["decision"] }> {
  validateReviewSetInput(input);
  return database.transaction().execute(async (transaction) => {
    const pending = await loadPendingReviewCoordination(transaction, input.workRef);
    if (!pending) throw new Error("review_set.coordination_missing");
    const requiredReviewers = ["integrative_review", ...input.requiredSpecialistNames];
    for (const reviewer of requiredReviewers) {
      const count = pending.records.filter((record) => record.reviewer === reviewer).length;
      if (count === 0) throw new Error(`review_set.reviewer_missing:${reviewer}`);
      if (count > 1) throw new Error(`review_set.reviewer_duplicate:${reviewer}`);
    }
    const records = reviewRecordSummaries(pending);
    if (findContraryReviewFindings(records).length > 0) {
      throw new Error("review_set.adjudication_required");
    }
    const decision = decideReviewSet({
      guardDecisions: [],
      records,
      requiredReviewers,
      targetSha: pending.targetSha,
      verification: { passed: true, targetSha: pending.targetSha },
    });
    if (decision.decision === "blocked" && decision.reason.includes("required_reviewer")) {
      throw new Error(`review_set.incomplete:${decision.reason}`);
    }
    const aggregateDecision = decision.decision;
    const unresolved =
      "unresolvedBlockingFindingIds" in decision
        ? [...decision.unresolvedBlockingFindingIds]
        : pending.records.flatMap((record) =>
            record.decision === "blocked"
              ? record.findings.filter((finding) => finding.blocking).map((finding) => finding.id)
              : [],
          );
    const requiredRoles = [
      "integrative_review",
      ...(input.requiredSpecialistNames.length > 0 ? ["specialist_review"] : []),
      ...(pending.records.some((record) => record.reviewerRole === "adjudication")
        ? ["adjudication"]
        : []),
    ];
    await sql`
      insert into review_sets (
        id, work_ref_kind, work_ref_id, target_sha, target_base_sha, patch_identity,
        required_reviewer_roles_json, required_specialist_names_json,
        verification_record_id, guard_decision_ids_json, review_record_ids_json,
        unresolved_blocking_finding_ids_json, carried_from_review_set_id,
        carry_forward_guard_decision_id, decision, created_at
      ) values (
        ${input.id}, ${input.workRef.kind}, ${input.workRef.id}, ${pending.targetSha},
        ${pending.targetBaseSha}, ${pending.patchIdentity}, ${JSON.stringify(requiredRoles)},
        ${JSON.stringify(input.requiredSpecialistNames)}, ${pending.verificationRecordId}, '[]',
        ${JSON.stringify(pending.records.map((record) => record.id))},
        ${JSON.stringify([...new Set(unresolved)])}, null, null, ${aggregateDecision},
        ${input.createdAt}
      )
    `.execute(transaction);
    const route = reviewSetRoute(aggregateDecision);
    const claim = await sql`
      update claims
      set mode = ${route.mode}, reason = ${route.reason}, updated_at = ${input.createdAt},
          expires_at = null, retry_due_at = null, blocker_predicate = null,
          question_id = null, approval_request_id = null
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'review_coordination_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("review_set.claim_not_ready");
    if (route.mode === "AwaitingHuman") {
      await sql`
        insert into parked_work (
          work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
          question_id, parked_at, last_checked_at, resolved_at
        ) values (
          ${input.workRef.kind}, ${input.workRef.id}, 'Review', ${route.reason}, null,
          null, ${input.createdAt}, ${input.createdAt}, null
        )
        on conflict (work_ref_kind, work_ref_id) do update set
          origin_stage = excluded.origin_stage, reason = excluded.reason,
          blocker_predicate = null, question_id = null, parked_at = excluded.parked_at,
          last_checked_at = excluded.last_checked_at, resolved_at = null
      `.execute(transaction);
    }
    return { decision: aggregateDecision };
  });
}

export async function routeNextReviewSpecialist(
  database: Kysely<DatabaseSchema>,
  input: {
    requiredSpecialistNames: readonly string[];
    updatedAt: string;
    workRef: WorkRef;
  },
): Promise<{ name: string } | null> {
  if (
    !Number.isFinite(Date.parse(input.updatedAt)) ||
    input.requiredSpecialistNames.some((name) => !name) ||
    new Set(input.requiredSpecialistNames).size !== input.requiredSpecialistNames.length
  ) {
    throw new Error("review.specialist_route_input_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const pending = await loadPendingReviewCoordination(transaction, input.workRef);
    if (!pending) throw new Error("review_set.coordination_missing");
    const name = input.requiredSpecialistNames.find(
      (candidate) => !pending.records.some((record) => record.reviewer === candidate),
    );
    if (!name) return null;
    const claim = await sql`
      update claims
      set reason = ${`specialist_review_required:${encodeURIComponent(name)}`},
          updated_at = ${input.updatedAt}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'review_coordination_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("review.specialist_claim_not_ready");
    return { name };
  });
}

export async function routeReviewAdjudication(
  database: Kysely<DatabaseSchema>,
  input: { updatedAt: string; workRef: WorkRef },
): Promise<readonly ReviewConflict[]> {
  if (!Number.isFinite(Date.parse(input.updatedAt))) {
    throw new Error("review.adjudication_route_input_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const pending = await loadPendingReviewCoordination(transaction, input.workRef);
    if (!pending) throw new Error("review_set.coordination_missing");
    const conflicts = findContraryReviewFindings(reviewRecordSummaries(pending));
    if (conflicts.length === 0) return [];
    const claim = await sql`
      update claims
      set reason = 'adjudication_required', updated_at = ${input.updatedAt}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'review_coordination_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("review.adjudication_claim_not_ready");
    return conflicts;
  });
}

export async function finishAdjudicationAttempt(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    costUsd: number | null;
    endedAt: string;
    questionId: string | null;
    reservationId: string;
    result: AdjudicationResult;
    reviewRecordId: string;
    settledLedgers: readonly { actualAmount: number; id: string }[];
    terminalResultId: string;
    usage: { inputTokens: number; outputTokens: number };
    workRef: WorkRef;
  },
): Promise<void> {
  const validation = validateAdjudicationResult(input.result);
  if (!validation.ok) throw new Error(validation.reason);
  if (
    !input.attemptId ||
    !input.reviewRecordId ||
    !input.terminalResultId ||
    (input.result.decision === "needs_human") !== Boolean(input.questionId)
  ) {
    throw new Error("adjudication.finish_input_invalid");
  }
  await database.transaction().execute(async (transaction) => {
    const pending = await loadPendingReviewCoordination(transaction, input.workRef);
    if (!pending || pending.targetSha !== input.result.target_sha) {
      throw new Error("adjudication.target_missing");
    }
    const conflicts = findContraryReviewFindings(reviewRecordSummaries(pending));
    const expectedConflictIds = conflicts.map((conflict) => conflict.conflictId).sort();
    const actualConflictIds = [...input.result.conflict_ids].sort();
    if (!stringListsEqual(expectedConflictIds, actualConflictIds)) {
      throw new Error("adjudication.conflict_set_mismatch");
    }
    if (input.result.decision === "resolve") {
      for (const resolution of input.result.resolutions) {
        const conflict = conflicts.find(
          (candidate) => candidate.conflictId === resolution.conflict_id,
        );
        if (!conflict) throw new Error("adjudication.conflict_missing");
        const upheld = new Set(resolution.upheld_finding_ids);
        const rejected = new Set(resolution.rejected_finding_ids);
        if (
          rejected.size === 0 ||
          [...upheld].some((id) => rejected.has(id)) ||
          !stringListsEqual(
            [...new Set([...upheld, ...rejected])].sort(),
            [...conflict.findingIds].sort(),
          )
        ) {
          throw new Error("adjudication.finding_partition_invalid");
        }
      }
    }
    await sql`
      insert into review_records (
        id, work_ref_kind, work_ref_id, attempt_id, reviewer_role, target_sha,
        target_base_sha, patch_identity, decision, findings_json, created_at
      ) values (
        ${input.reviewRecordId}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
        'adjudication', ${pending.targetSha}, ${pending.targetBaseSha}, ${pending.patchIdentity},
        ${input.result.decision === "resolve" ? "approve" : "needs_human"}, '[]', ${input.endedAt}
      )
    `.execute(transaction);
    if (input.result.decision === "needs_human") {
      const questionId = input.questionId as string;
      await sql`
        insert into operator_questions (
          id, work_ref_kind, work_ref_id, attempt_id, text, options_json,
          default_answer, comment_marker, comment_cursor, asked_at,
          reminded_at, answered_at, answer, answered_by
        ) values (
          ${questionId}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
          ${input.result.question.text}, ${JSON.stringify(input.result.question.options)},
          ${input.result.question.default}, ${`symphony-question:${questionId}`}, null,
          ${input.endedAt}, null, null, null, null
        )
      `.execute(transaction);
      await sql`
        insert into parked_work (
          work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
          question_id, parked_at, last_checked_at, resolved_at
        ) values (
          ${input.workRef.kind}, ${input.workRef.id}, 'Review', 'human_review', null,
          ${questionId}, ${input.endedAt}, ${input.endedAt}, null
        )
        on conflict (work_ref_kind, work_ref_id) do update set
          origin_stage = excluded.origin_stage, reason = excluded.reason,
          blocker_predicate = null, question_id = excluded.question_id,
          parked_at = excluded.parked_at, last_checked_at = excluded.last_checked_at,
          resolved_at = null
      `.execute(transaction);
    }
    await finishAttemptInTransaction(transaction, {
      attemptId: input.attemptId,
      costUsd: input.costUsd,
      endedAt: input.endedAt,
      failureClass: null,
      nextClaim:
        input.result.decision === "resolve"
          ? { mode: "Ready", reason: "review_coordination_required" }
          : {
              approvalRequestId: null,
              blockerPredicate: null,
              mode: "AwaitingHuman",
              questionId: input.questionId,
              reason: "human_review",
            },
      reservationId: input.reservationId,
      settledLedgers: input.settledLedgers,
      terminalResult: {
        id: input.terminalResultId,
        kind: "adjudication_result",
        payload: input.result,
        role: "adjudication",
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
    (input.reviewerRole !== "integrative_review" && input.reviewerRole !== "specialist_review") ||
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

function coordinationRecord(row: CoordinationRecordRow, workRef: WorkRef) {
  const findings: unknown = JSON.parse(row.findings_json);
  const record = {
    attempt_id: row.attempt_id,
    created_at: row.created_at,
    decision: row.decision,
    findings,
    id: row.id,
    patch_identity: row.patch_identity,
    reviewer_role: row.reviewer_role,
    target_base_sha: row.target_base_sha,
    target_sha: row.target_sha,
    work_ref: workRef.kind === "issue" ? { issue_id: workRef.id } : { system_job_id: workRef.id },
  };
  if (!isReviewRecord(record)) throw new Error("review.persisted_record_invalid");
  const reasons: unknown = JSON.parse(row.routing_reasons_json);
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string")) {
    throw new Error("review.persisted_routing_reasons_invalid");
  }
  const reviewer =
    row.reviewer_role === "specialist_review"
      ? reasons.find((reason) => reason.startsWith("specialist.name:"))?.slice(16)
      : row.reviewer_role;
  if (!reviewer) throw new Error("review.persisted_specialist_identity_missing");
  return {
    decision: record.decision,
    findings: record.findings,
    id: record.id,
    reviewer,
    reviewerRole: record.reviewer_role,
    targetSha: record.target_sha,
  };
}

function parseStringList(value: string, message: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string") ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(message);
  }
  return parsed as string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reviewRecordSummaries(pending: PendingReviewCoordination): ReviewRecordSummary[] {
  const rejected = new Set(pending.rejectedFindingIds);
  return pending.records.map((record) => ({
    decision: record.decision,
    findings: record.findings
      .filter((finding) => !rejected.has(finding.id))
      .map((finding) => ({
        behavior: finding.behavior,
        blocking: finding.blocking,
        disposition: finding.disposition,
        evidenceKey: stableJson(finding.evidence),
        id: finding.id,
      })),
    reviewer: record.reviewer,
    targetSha: record.targetSha,
  }));
}

async function loadRejectedFindingIds(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  workRef: WorkRef,
  targetSha: string,
): Promise<string[]> {
  const query = await sql<AdjudicationResultRow>`
    select result.payload_json
    from terminal_results result
    join attempts attempt on attempt.id = result.attempt_id
    where attempt.work_ref_kind = ${workRef.kind}
      and attempt.work_ref_id = ${workRef.id}
      and attempt.role = 'adjudication'
      and attempt.status = 'closed'
      and result.role = 'adjudication'
      and result.result_kind = 'adjudication_result'
    order by attempt.attempt_number
  `.execute(database);
  const rejectedFindingIds = new Set<string>();
  for (const row of query.rows) {
    const result: unknown = JSON.parse(row.payload_json);
    const validation = validateAdjudicationResult(result);
    if (!validation.ok) throw new Error(`review.persisted_${validation.reason}`);
    const adjudication = result as AdjudicationResult;
    if (adjudication.decision !== "resolve" || adjudication.target_sha !== targetSha) continue;
    for (const resolution of adjudication.resolutions) {
      for (const findingId of resolution.rejected_finding_ids) {
        rejectedFindingIds.add(findingId);
      }
    }
  }
  return [...rejectedFindingIds];
}

function validateReviewSetInput(input: {
  createdAt: string;
  id: string;
  requiredSpecialistNames: readonly string[];
}): void {
  if (
    !input.id ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    input.requiredSpecialistNames.some((name) => !name) ||
    new Set(input.requiredSpecialistNames).size !== input.requiredSpecialistNames.length
  ) {
    throw new Error("review_set.input_invalid");
  }
}

function reviewSetRoute(decision: ReviewRecord["decision"]): {
  mode: "Ready" | "AwaitingHuman";
  reason: string;
} {
  switch (decision) {
    case "approve":
      return { mode: "Ready", reason: "pull_request_required" };
    case "needs_rework":
      return { mode: "Ready", reason: "review_rework" };
    case "needs_human":
      return { mode: "AwaitingHuman", reason: "human_review" };
    case "blocked":
      return { mode: "AwaitingHuman", reason: "blocked" };
  }
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
