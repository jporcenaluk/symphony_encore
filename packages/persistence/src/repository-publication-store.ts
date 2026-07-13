import type { RepositoryLink, SideEffectReceipt } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { recordSideEffectReceiptInTransaction } from "./side-effect-store.js";
import { transitionStageInTransaction } from "./stage-transition.js";

type WorkRef = { id: string; kind: "issue" | "system_job" };

export interface PendingRepositoryPublication {
  attemptId: string;
  baseRef: string;
  baseSha: string;
  configSnapshotId: string;
  cycle: number;
  localBranch: string;
  repository: string;
  targetSha: string;
  verificationRecordId: string;
  workspacePath: string;
}

interface PendingPublicationRow {
  attempt_id: string;
  base_ref: string | null;
  base_sha: string;
  config_snapshot_id: string;
  cycle: number;
  local_branch: string;
  repository: string;
  target_revision: string;
  verification_record_id: string;
  workspace_path: string;
}

export async function loadPendingRepositoryPublication(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingRepositoryPublication | null> {
  const result = await sql<PendingPublicationRow>`
    select verification.attempt_id,
           checkout.base_ref,
           checkout.base_sha,
           verification.config_snapshot_id,
           coalesce((
             select max(link.cycle)
             from repository_links link
             where link.work_ref_kind = claim.work_ref_kind
               and link.work_ref_id = claim.work_ref_id
           ), 0) + 1 as cycle,
           checkout.local_branch,
           checkout.repository,
           verification.target_revision,
           verification.id as verification_record_id,
           checkout.workspace_path
    from claims claim
    join workspace_checkouts checkout
      on checkout.work_ref_kind = claim.work_ref_kind
      and checkout.work_ref_id = claim.work_ref_id
    join verification_records verification
      on verification.work_ref_kind = claim.work_ref_kind
      and verification.work_ref_id = claim.work_ref_id
      and verification.result = 'passed'
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = 'pull_request_required'
    order by verification.ended_at desc, verification.id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  if (!row) return null;
  if (!row.base_ref) throw new Error("publication.base_ref_missing");
  if (!/^[A-Fa-f0-9]{7,64}$/u.test(row.base_sha)) {
    throw new Error("publication.base_sha_invalid");
  }
  if (!/^[A-Fa-f0-9]{7,64}$/u.test(row.target_revision)) {
    throw new Error("publication.target_sha_invalid");
  }
  return {
    attemptId: row.attempt_id,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    configSnapshotId: row.config_snapshot_id,
    cycle: row.cycle,
    localBranch: row.local_branch,
    repository: row.repository,
    targetSha: row.target_revision,
    verificationRecordId: row.verification_record_id,
    workspacePath: row.workspace_path,
  };
}

export async function commitRepositoryLinkAndReviewLane(
  database: Kysely<DatabaseSchema>,
  input: {
    expectedReadyReason: string;
    link: RepositoryLink;
    nextReadyReason: string;
    receipt: SideEffectReceipt;
    transitionId: string;
  },
): Promise<void> {
  if (!("issue_id" in input.link.work_ref)) {
    throw new Error("publication.issue_required");
  }
  if (input.receipt.result_revision === null) {
    throw new Error("publication.tracker_revision_missing");
  }
  const issueId = input.link.work_ref.issue_id;
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    await transitionStageInTransaction(transaction, {
      attemptId: null,
      confirmedExternalRevision: input.receipt.result_revision,
      enteredAt: input.receipt.applied_at,
      expectedFromStage: "In Progress",
      id: input.transitionId,
      reason: "publication.verified",
      timestampSource: "receipt",
      toStage: "Review",
      workRef: { id: issueId, kind: "issue" },
    });
    const issue = await sql`
      update issues
      set state = 'Review',
          provider_revision = ${input.receipt.result_revision},
          updated_at = ${input.receipt.applied_at}
      where id = ${issueId} and state = 'In Progress'
    `.execute(transaction);
    if (issue.numAffectedRows !== 1n) throw new Error("publication.issue_state_mismatch");
    const [existing] = (
      await sql<{ id: string; head_sha: string; pull_request_number: number }>`
        select id, head_sha, pull_request_number
        from repository_links
        where work_ref_kind = 'issue'
          and work_ref_id = ${issueId}
          and cycle = ${input.link.cycle}
          and kind = ${input.link.kind}
      `.execute(transaction)
    ).rows;
    if (existing) {
      if (
        existing.id !== input.link.id ||
        existing.head_sha !== input.link.head_sha ||
        existing.pull_request_number !== input.link.pull_request_number
      ) {
        throw new Error("publication.repository_link_conflict");
      }
    } else {
      await sql`
        insert into repository_links (
          id, work_ref_kind, work_ref_id, cycle, kind, repo_owner, repo_name,
          branch, pull_request_number, pull_request_url, head_sha, base_ref, base_sha,
          state, created_at, updated_at
        ) values (
          ${input.link.id}, 'issue', ${issueId}, ${input.link.cycle}, ${input.link.kind},
          ${input.link.repo_owner}, ${input.link.repo_name}, ${input.link.branch},
          ${input.link.pull_request_number}, ${input.link.pull_request_url},
          ${input.link.head_sha}, ${input.link.base_ref}, ${input.link.base_sha},
          ${input.link.state}, ${input.link.created_at}, ${input.link.updated_at}
        )
      `.execute(transaction);
    }
    const claim = await sql`
      update claims
      set reason = ${input.nextReadyReason}, updated_at = ${input.receipt.applied_at}
      where work_ref_kind = 'issue'
        and work_ref_id = ${issueId}
        and mode = 'Ready'
        and reason = ${input.expectedReadyReason}
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("publication.claim_not_ready");
  });
}
