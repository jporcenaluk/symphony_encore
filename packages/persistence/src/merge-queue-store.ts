import type { SideEffectReceipt } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { recordSideEffectReceiptInTransaction } from "./side-effect-store.js";
import {
  openBaselineStageInTransaction,
  transitionStageInTransaction,
} from "./stage-transition.js";

type WorkRef = { id: string; kind: "issue" | "system_job" };

export interface PendingMergeQueue {
  attemptId: string;
  baseRef: string;
  baseSha: string;
  branch: string;
  changeClass: "high_risk" | "standard" | "trivial";
  configSnapshotId: string;
  headSha: string;
  patchIdentity: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  repository: string;
  reviewSetId: string;
  workspacePath: string;
}

export interface PendingPostMerge {
  attemptId: string;
  configSnapshotId: string;
  mergeSha: string;
  providerRevision: string;
  repository: string;
  startedAt: string;
}

interface PendingMergeQueueRow {
  attempt_id: string;
  base_ref: string;
  base_sha: string;
  branch: string;
  change_class: "high_risk" | "standard" | "trivial";
  config_snapshot_id: string;
  head_sha: string;
  patch_identity: string;
  pull_request_number: number;
  pull_request_url: string;
  repo_name: string;
  repo_owner: string;
  review_set_id: string;
  workspace_path: string;
}

export async function loadPendingMergeQueue(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingMergeQueue | null> {
  return loadPendingRepositoryMutation(database, workRef, "merge_queue_required");
}

export async function loadPendingBaseUpdate(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingMergeQueue | null> {
  return loadPendingRepositoryMutation(database, workRef, "base_update_required");
}

async function loadPendingRepositoryMutation(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
  expectedReason: "base_update_required" | "merge_queue_required",
): Promise<PendingMergeQueue | null> {
  const result = await sql<PendingMergeQueueRow>`
    select verification.attempt_id,
           link.base_ref,
           review_set.target_base_sha as base_sha,
           link.branch,
           attempt.change_class,
           verification.config_snapshot_id,
           review_set.target_sha as head_sha,
           review_set.patch_identity,
           link.pull_request_number,
           link.pull_request_url,
           link.repo_name,
           link.repo_owner,
           review_set.id as review_set_id,
           checkout.workspace_path
    from claims claim
    join review_sets review_set
      on review_set.work_ref_kind = claim.work_ref_kind
      and review_set.work_ref_id = claim.work_ref_id
      and review_set.decision = 'approve'
    join verification_records verification
      on verification.id = review_set.verification_record_id
      and verification.result = 'passed'
      and verification.target_revision = review_set.target_sha
    join attempts attempt on attempt.id = verification.attempt_id
    join repository_links link
      on link.work_ref_kind = claim.work_ref_kind
      and link.work_ref_id = claim.work_ref_id
      and link.head_sha = review_set.target_sha
      and link.base_sha = review_set.target_base_sha
      and link.state = 'open'
    join workspace_checkouts checkout
      on checkout.work_ref_kind = claim.work_ref_kind
      and checkout.work_ref_id = claim.work_ref_id
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = ${expectedReason}
    order by review_set.created_at desc, review_set.id desc,
             link.cycle desc, link.created_at desc, link.id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row
    ? {
        attemptId: row.attempt_id,
        baseRef: row.base_ref,
        baseSha: row.base_sha,
        branch: row.branch,
        changeClass: row.change_class,
        configSnapshotId: row.config_snapshot_id,
        headSha: row.head_sha,
        patchIdentity: row.patch_identity,
        pullRequestNumber: row.pull_request_number,
        pullRequestUrl: row.pull_request_url,
        repository: `${row.repo_owner}/${row.repo_name}`,
        reviewSetId: row.review_set_id,
        workspacePath: row.workspace_path,
      }
    : null;
}

export async function beginRepositoryBranchUpdate(
  database: Kysely<DatabaseSchema>,
  input: {
    baseSha: string;
    headSha: string;
    now: string;
    repository: string;
    transitionId?: string;
    workRef: WorkRef;
  },
): Promise<void> {
  validateTimestamp(input.now);
  await database.transaction().execute(async (transaction) => {
    if (input.workRef.kind === "system_job") {
      if (!input.transitionId) throw new Error("merge_queue.transition_identity_missing");
      const job = await sql`
        update system_jobs set status = 'merge'
        where id = ${input.workRef.id} and status = 'review'
      `.execute(transaction);
      if (job.numAffectedRows !== 1n) throw new Error("merge_queue.system_job_not_review");
      await transitionStageInTransaction(transaction, {
        attemptId: null,
        confirmedExternalRevision: null,
        enteredAt: input.now,
        expectedFromStage: "review",
        id: input.transitionId,
        reason: "merge_queue.started",
        timestampSource: "observed_estimate",
        toStage: "merge",
        workRef: input.workRef,
      });
    }
    await sql`
      insert into repository_merge_queue_entries (
        work_ref_kind, work_ref_id, repository, state, head_sha, base_sha,
        merge_sha, created_at, updated_at
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, ${input.repository}, 'landing',
        ${input.headSha}, ${input.baseSha}, null, ${input.now}, ${input.now}
      )
    `.execute(transaction);
    const claim = await sql`
      update claims
      set reason = 'base_update_landing', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'base_update_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_base_update");
  });
}

export async function commitRepositoryBranchUpdate(
  database: Kysely<DatabaseSchema>,
  input: {
    baseSha: string;
    headSha: string;
    now: string;
    receipt: SideEffectReceipt;
    workRef: WorkRef;
  },
): Promise<void> {
  validateTimestamp(input.now);
  if (input.receipt.result_revision !== input.headSha) {
    throw new Error("merge_queue.receipt_revision_mismatch");
  }
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    const link = await sql`
      update repository_links
      set head_sha = ${input.headSha}, base_sha = ${input.baseSha}, updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'open'
    `.execute(transaction);
    if (link.numAffectedRows !== 1n) throw new Error("merge_queue.link_not_open");
    const checkout = await sql`
      update workspace_checkouts
      set base_sha = ${input.baseSha}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
    `.execute(transaction);
    if (checkout.numAffectedRows !== 1n) throw new Error("merge_queue.checkout_missing");
    const claim = await sql`
      update claims
      set reason = 'independent_verification_after_base_update_required', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'base_update_landing'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_base_update");
    const queue = await sql`
      delete from repository_merge_queue_entries
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'landing'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_landing");
  });
}

export async function loadAuthorizedMergeLogins(
  database: Kysely<DatabaseSchema>,
): Promise<string[]> {
  const result = await sql<{ tracker_login: string }>`
    select operator.tracker_login
    from operators operator
    where operator.status = 'active'
      and operator.tracker_login is not null
      and exists (
        select 1
        from json_each(operator.capabilities_json) capability
        where capability.value = 'merge_queue.write'
      )
    order by operator.tracker_login
  `.execute(database);
  return result.rows.map((row) => row.tracker_login);
}

export async function hasActiveRepositoryMerge(
  database: Kysely<DatabaseSchema>,
  repository: string,
): Promise<boolean> {
  const result = await sql<{ active: number }>`
    select exists(
      select 1
      from repository_merge_queue_entries
      where repository = ${repository} and state in ('landing', 'post_merge')
    ) as active
  `.execute(database);
  return result.rows[0]?.active === 1;
}

export async function loadPendingPostMerge(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingPostMerge | null> {
  const result = await sql<{
    attempt_id: string;
    config_snapshot_id: string;
    created_at: string;
    merge_sha: string;
    provider_revision: string;
    repository: string;
  }>`
    select verification.attempt_id,
           verification.config_snapshot_id,
           queue.created_at,
           queue.merge_sha,
           coalesce(issue.provider_revision, job.config_snapshot_id) as provider_revision,
           queue.repository
    from claims claim
    join repository_merge_queue_entries queue
      on queue.work_ref_kind = claim.work_ref_kind
      and queue.work_ref_id = claim.work_ref_id
      and queue.state = 'post_merge'
      and queue.merge_sha is not null
    left join issues issue
      on claim.work_ref_kind = 'issue'
      and issue.id = claim.work_ref_id
    left join system_jobs job
      on claim.work_ref_kind = 'system_job'
      and job.id = claim.work_ref_id
    join review_sets review_set
      on review_set.work_ref_kind = claim.work_ref_kind
      and review_set.work_ref_id = claim.work_ref_id
      and review_set.target_sha = queue.head_sha
      and review_set.target_base_sha = queue.base_sha
      and review_set.decision = 'approve'
    join verification_records verification on verification.id = review_set.verification_record_id
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = 'post_merge_verification_required'
    order by review_set.created_at desc, review_set.id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row
    ? {
        attemptId: row.attempt_id,
        configSnapshotId: row.config_snapshot_id,
        mergeSha: row.merge_sha,
        providerRevision: row.provider_revision,
        repository: row.repository,
        startedAt: row.created_at,
      }
    : null;
}

export async function beginMergeQueueLanding(
  database: Kysely<DatabaseSchema>,
  input: {
    baseSha: string;
    headSha: string;
    now: string;
    repository: string;
    workRef: WorkRef;
  },
): Promise<void> {
  validateTimestamp(input.now);
  await database.transaction().execute(async (transaction) => {
    await sql`
      insert into repository_merge_queue_entries (
        work_ref_kind, work_ref_id, repository, state, head_sha, base_sha,
        merge_sha, created_at, updated_at
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, ${input.repository}, 'landing',
        ${input.headSha}, ${input.baseSha}, null, ${input.now}, ${input.now}
      )
    `.execute(transaction);
    const claim = await sql`
      update claims
      set reason = 'merge_queue_landing', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'merge_queue_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_ready");
  });
}

export async function routeMergeQueueRetry(
  database: Kysely<DatabaseSchema>,
  input: { now: string; retryDueAt: string; workRef: WorkRef },
): Promise<void> {
  validateTimestamp(input.now);
  validateTimestamp(input.retryDueAt);
  if (Date.parse(input.retryDueAt) <= Date.parse(input.now)) {
    throw new Error("merge_queue.retry_due_at_invalid");
  }
  const claim = await sql`
    update claims
    set mode = 'RetryQueued', reason = 'merge_queue_required',
        retry_due_at = ${input.retryDueAt}, expires_at = null, updated_at = ${input.now},
        blocker_predicate = null, question_id = null, approval_request_id = null
    where work_ref_kind = ${input.workRef.kind}
      and work_ref_id = ${input.workRef.id}
      and mode = 'Ready'
      and reason = 'merge_queue_required'
  `.execute(database);
  if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_ready");
}

export async function routeMergeQueuePrecondition(
  database: Kysely<DatabaseSchema>,
  input: { now: string; reason: string; workRef: WorkRef },
): Promise<void> {
  validateTimestamp(input.now);
  if (!input.reason) throw new Error("merge_queue.reason_invalid");
  const claim = await sql`
    update claims
    set reason = ${input.reason}, updated_at = ${input.now}
    where work_ref_kind = ${input.workRef.kind}
      and work_ref_id = ${input.workRef.id}
      and mode = 'Ready'
      and reason = 'merge_queue_required'
  `.execute(database);
  if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_ready");
}

export async function commitMergeQueueLanding(
  database: Kysely<DatabaseSchema>,
  input: {
    mergeSha: string;
    now: string;
    receipt: SideEffectReceipt;
    retryDueAt: string;
    workRef: WorkRef;
  },
): Promise<void> {
  validateTimestamp(input.now);
  validateTimestamp(input.retryDueAt);
  if (Date.parse(input.retryDueAt) <= Date.parse(input.now)) {
    throw new Error("merge_queue.retry_due_at_invalid");
  }
  if (input.receipt.result_revision !== input.mergeSha) {
    throw new Error("merge_queue.receipt_revision_mismatch");
  }
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    const queue = await sql`
      update repository_merge_queue_entries
      set state = 'post_merge', merge_sha = ${input.mergeSha}, updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'landing'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_landing");
    const link = await sql`
      update repository_links
      set state = 'merged', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'open'
    `.execute(transaction);
    if (link.numAffectedRows !== 1n) throw new Error("merge_queue.link_not_open");
    const claim = await sql`
      update claims
      set mode = 'RetryQueued', reason = 'post_merge_verification_required',
          retry_due_at = ${input.retryDueAt}, expires_at = null, updated_at = ${input.now},
          blocker_predicate = null, question_id = null, approval_request_id = null
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'merge_queue_landing'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_landing");
  });
}

export async function commitPostMergeSuccess(
  database: Kysely<DatabaseSchema>,
  input: {
    now: string;
    receipt: SideEffectReceipt;
    transitionId: string;
    workRef: WorkRef;
  },
): Promise<void> {
  validateTimestamp(input.now);
  if (input.workRef.kind !== "issue") throw new Error("merge_queue.issue_required");
  if (!input.transitionId || input.receipt.result_revision === null) {
    throw new Error("merge_queue.completion_input_invalid");
  }
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    await transitionStageInTransaction(transaction, {
      attemptId: null,
      confirmedExternalRevision: input.receipt.result_revision,
      enteredAt: input.now,
      expectedFromStage: "Review",
      id: input.transitionId,
      reason: "merge_queue.post_merge_checks_passed",
      timestampSource: "receipt",
      toStage: "Done",
      workRef: input.workRef,
    });
    const issue = await sql`
      update issues
      set state = 'Done', provider_revision = ${input.receipt.result_revision},
          updated_at = ${input.now}
      where id = ${input.workRef.id} and state = 'Review'
    `.execute(transaction);
    if (issue.numAffectedRows !== 1n) throw new Error("merge_queue.issue_not_review");
    const queue = await sql`
      update repository_merge_queue_entries
      set state = 'completed', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'post_merge'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_post_merge");
    const claim = await sql`
      delete from claims
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'post_merge_verification_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_post_merge");
  });
}

export async function commitPostMergeSystemJobSuccess(
  database: Kysely<DatabaseSchema>,
  input: { now: string; transitionId: string; workRef: WorkRef },
): Promise<void> {
  validateTimestamp(input.now);
  if (input.workRef.kind !== "system_job" || !input.transitionId) {
    throw new Error("merge_queue.system_job_completion_input_invalid");
  }
  await database.transaction().execute(async (transaction) => {
    const jobRow = await sql<{
      parent_work_ref_id: string | null;
      parent_work_ref_kind: "issue" | "system_job" | null;
    }>`
      select parent_work_ref_kind, parent_work_ref_id
      from system_jobs where id = ${input.workRef.id} and status = 'merge'
    `.execute(transaction);
    const job = jobRow.rows[0];
    if (!job) throw new Error("merge_queue.system_job_not_review");
    const latestResult = await sql<{ terminal_result_id: string }>`
      select terminal_result_id
      from attempts
      where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
        and terminal_result_id is not null
      order by attempt_number desc
      limit 1
    `.execute(transaction);
    const finalResultId = latestResult.rows[0]?.terminal_result_id;
    if (!finalResultId) throw new Error("merge_queue.system_job_result_missing");
    await transitionStageInTransaction(transaction, {
      attemptId: null,
      confirmedExternalRevision: null,
      enteredAt: input.now,
      expectedFromStage: "merge",
      id: input.transitionId,
      reason: "merge_queue.post_merge_checks_passed",
      timestampSource: "observed_estimate",
      toStage: "done",
      workRef: input.workRef,
    });
    const updatedJob = await sql`
      update system_jobs
      set status = 'done', ended_at = ${input.now}, final_result_id = ${finalResultId}
      where id = ${input.workRef.id} and status = 'merge'
    `.execute(transaction);
    if (updatedJob.numAffectedRows !== 1n) throw new Error("merge_queue.system_job_not_review");
    const queue = await sql`
      update repository_merge_queue_entries
      set state = 'completed', updated_at = ${input.now}
      where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
        and state = 'post_merge'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_post_merge");
    const claim = await sql`
      delete from claims
      where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
        and mode = 'Ready' and reason = 'post_merge_verification_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_post_merge");
    if (job.parent_work_ref_kind && job.parent_work_ref_id) {
      await sql`
        update parked_work
        set resolved_at = ${input.now}, last_checked_at = ${input.now}
        where work_ref_kind = ${job.parent_work_ref_kind}
          and work_ref_id = ${job.parent_work_ref_id}
          and resolved_at is null
          and blocker_predicate = ${`system_job:${input.workRef.id}:not_terminal`}
      `.execute(transaction);
      const parentClaim = await sql`
        update claims
        set mode = 'Ready', reason = 'repair_completed', updated_at = ${input.now},
            blocker_predicate = null, question_id = null, approval_request_id = null
        where work_ref_kind = ${job.parent_work_ref_kind}
          and work_ref_id = ${job.parent_work_ref_id}
          and mode = 'AwaitingHuman'
          and reason = ${`repair_in_progress:${input.workRef.id}`}
      `.execute(transaction);
      if (parentClaim.numAffectedRows !== 1n) {
        throw new Error("merge_queue.repair_parent_claim_missing");
      }
    }
  });
}

export async function routePostMergeRetry(
  database: Kysely<DatabaseSchema>,
  input: { now: string; retryDueAt: string; workRef: WorkRef },
): Promise<void> {
  validateTimestamp(input.now);
  validateTimestamp(input.retryDueAt);
  if (Date.parse(input.retryDueAt) <= Date.parse(input.now)) {
    throw new Error("merge_queue.retry_due_at_invalid");
  }
  const claim = await sql`
    update claims
    set mode = 'RetryQueued', retry_due_at = ${input.retryDueAt}, expires_at = null,
        updated_at = ${input.now}
    where work_ref_kind = ${input.workRef.kind}
      and work_ref_id = ${input.workRef.id}
      and mode = 'Ready'
      and reason = 'post_merge_verification_required'
  `.execute(database);
  if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_post_merge");
}

export async function routePostMergeFailure(
  database: Kysely<DatabaseSchema>,
  input: { now: string; reason: string; workRef: WorkRef },
): Promise<void> {
  validateTimestamp(input.now);
  if (!input.reason) throw new Error("merge_queue.reason_invalid");
  await database.transaction().execute(async (transaction) => {
    const queue = await sql`
      update repository_merge_queue_entries
      set state = 'failed', updated_at = ${input.now}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and state = 'post_merge'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_post_merge");
    const claim = await sql`
      update claims
      set mode = 'AwaitingHuman', reason = 'post_merge_failed', retry_due_at = null,
          expires_at = null, blocker_predicate = ${input.reason}, updated_at = ${input.now},
          question_id = null, approval_request_id = null
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'post_merge_verification_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_post_merge");
    await sql`
      insert into parked_work (
        work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
        question_id, parked_at, last_checked_at, resolved_at
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, 'Review', 'post_merge_failed',
        ${input.reason}, null, ${input.now}, ${input.now}, null
      )
      on conflict (work_ref_kind, work_ref_id) do update set
        origin_stage = excluded.origin_stage, reason = excluded.reason,
        blocker_predicate = excluded.blocker_predicate, question_id = null,
        parked_at = excluded.parked_at, last_checked_at = excluded.last_checked_at,
        resolved_at = null
    `.execute(transaction);
  });
}

export async function commitPostMergeRepairCycle(
  database: Kysely<DatabaseSchema>,
  input: {
    acceptanceCriteria: readonly string[];
    configSnapshotId: string;
    goal: string;
    now: string;
    receipt: SideEffectReceipt;
    repairJobId: string;
    repository: string;
    transitionId: string;
    workRef: WorkRef;
    workspacePath: string;
  },
): Promise<void> {
  validateTimestamp(input.now);
  if (
    input.workRef.kind !== "issue" ||
    !input.repairJobId ||
    !input.transitionId ||
    !input.repository ||
    !input.workspacePath ||
    !input.goal ||
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.some((criterion) => !criterion) ||
    input.receipt.result_revision === null
  ) {
    throw new Error("merge_queue.repair_input_invalid");
  }
  await database.transaction().execute(async (transaction) => {
    const currentClaim = await sql<{ holder: string }>`
      select holder from claims
      where work_ref_kind = 'issue' and work_ref_id = ${input.workRef.id}
        and mode = 'Ready' and reason = 'post_merge_verification_required'
    `.execute(transaction);
    const holder = currentClaim.rows[0]?.holder;
    if (!holder) throw new Error("merge_queue.claim_not_post_merge");
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    await transitionStageInTransaction(transaction, {
      attemptId: null,
      confirmedExternalRevision: input.receipt.result_revision,
      enteredAt: input.now,
      expectedFromStage: "Review",
      id: input.transitionId,
      reason: "merge_queue.post_merge_failed",
      timestampSource: "receipt",
      toStage: "In Progress",
      workRef: input.workRef,
    });
    const issue = await sql`
      update issues
      set state = 'In Progress', provider_revision = ${input.receipt.result_revision},
          updated_at = ${input.now}
      where id = ${input.workRef.id} and state = 'Review'
    `.execute(transaction);
    if (issue.numAffectedRows !== 1n) throw new Error("merge_queue.issue_not_review");
    const queue = await sql`
      update repository_merge_queue_entries
      set state = 'failed', updated_at = ${input.now}
      where work_ref_kind = 'issue' and work_ref_id = ${input.workRef.id}
        and state = 'post_merge'
    `.execute(transaction);
    if (queue.numAffectedRows !== 1n) throw new Error("merge_queue.entry_not_post_merge");
    const originalClaim = await sql`
      update claims
      set mode = 'AwaitingHuman', reason = ${`repair_in_progress:${input.repairJobId}`},
          retry_due_at = null, expires_at = null,
          blocker_predicate = ${`system_job:${input.repairJobId}:not_terminal`},
          updated_at = ${input.now}, question_id = null, approval_request_id = null
      where work_ref_kind = 'issue' and work_ref_id = ${input.workRef.id}
        and mode = 'Ready' and reason = 'post_merge_verification_required'
    `.execute(transaction);
    if (originalClaim.numAffectedRows !== 1n) throw new Error("merge_queue.claim_not_post_merge");
    await sql`
      insert into parked_work (
        work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
        question_id, parked_at, last_checked_at, resolved_at
      ) values (
        'issue', ${input.workRef.id}, 'In Progress',
        ${`repair_in_progress:${input.repairJobId}`},
        ${`system_job:${input.repairJobId}:not_terminal`}, null,
        ${input.now}, ${input.now}, null
      )
      on conflict (work_ref_kind, work_ref_id) do update set
        origin_stage = excluded.origin_stage, reason = excluded.reason,
        blocker_predicate = excluded.blocker_predicate, question_id = null,
        parked_at = excluded.parked_at, last_checked_at = excluded.last_checked_at,
        resolved_at = null
    `.execute(transaction);
    await sql`
      insert into system_jobs (
        id, kind, parent_work_ref_kind, parent_work_ref_id, repository,
        workspace_path, goal, acceptance_criteria_json, config_snapshot_id,
        status, input_tokens, output_tokens, cost_usd, created_at, started_at,
        ended_at, final_result_id
      ) values (
        ${input.repairJobId}, 'repair', 'issue', ${input.workRef.id},
        ${input.repository}, ${input.workspacePath}, ${input.goal},
        ${JSON.stringify(input.acceptanceCriteria)}, ${input.configSnapshotId},
        'queued', 0, 0, null, ${input.now}, null, null, null
      )
    `.execute(transaction);
    await openBaselineStageInTransaction(transaction, {
      enteredAt: input.now,
      id: `${input.transitionId}:repair-job`,
      reason: "merge_queue.post_merge_failed",
      timestampSource: "receipt",
      toStage: "queued",
      workRef: { id: input.repairJobId, kind: "system_job" },
    });
    await sql`
      insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason, retry_due_at, blocker_predicate,
        question_id, approval_request_id, last_comment_cursor
      ) values (
        'system_job', ${input.repairJobId}, ${holder}, 'Ready', ${input.now},
        ${input.now}, null, 'queued', 'system_job_dispatch_required', null,
        null, null, null, null
      )
    `.execute(transaction);
  });
}

function validateTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("merge_queue.time_invalid");
}
