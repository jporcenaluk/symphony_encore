import type { PullRequestGateDecision } from "@symphony/domain";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

type WorkRef = { id: string; kind: "issue" | "system_job" };

export interface PendingPullRequestGate {
  baseRef: string;
  baseSha: string;
  branch: string;
  cycle: number;
  headSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  repository: string;
}

interface PullRequestGateRow {
  base_ref: string;
  base_sha: string;
  branch: string;
  cycle: number;
  head_sha: string;
  pull_request_number: number;
  pull_request_url: string;
  repo_name: string;
  repo_owner: string;
}

export async function loadPendingPullRequestGate(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
): Promise<PendingPullRequestGate | null> {
  const result = await sql<PullRequestGateRow>`
    select link.*
    from claims claim
    join repository_links link
      on link.work_ref_kind = claim.work_ref_kind
      and link.work_ref_id = claim.work_ref_id
      and link.kind = 'primary'
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = 'pull_request_hygiene_required'
    order by link.cycle desc, link.created_at desc, link.id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row
    ? {
        baseRef: row.base_ref,
        baseSha: row.base_sha,
        branch: row.branch,
        cycle: row.cycle,
        headSha: row.head_sha,
        pullRequestNumber: row.pull_request_number,
        pullRequestUrl: row.pull_request_url,
        repository: `${row.repo_owner}/${row.repo_name}`,
      }
    : null;
}

interface GateStateRow {
  material_hash: string;
  material_since: string;
  settle_started_at: string;
}

export async function observePullRequestGateMaterial(
  database: Kysely<DatabaseSchema>,
  input: { materialHash: string; observedAt: string; workRef: WorkRef },
): Promise<{ materialSince: string; settleStartedAt: string }> {
  if (!input.materialHash || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("pull_request_gate.observation_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const existing = await sql<GateStateRow>`
      select material_hash, material_since, settle_started_at
      from pull_request_gate_states
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
    `.execute(transaction);
    const row = existing.rows[0];
    if (!row) {
      await sql`
        insert into pull_request_gate_states (
          work_ref_kind, work_ref_id, material_hash, material_since,
          settle_started_at, updated_at
        ) values (
          ${input.workRef.kind}, ${input.workRef.id}, ${input.materialHash},
          ${input.observedAt}, ${input.observedAt}, ${input.observedAt}
        )
      `.execute(transaction);
      return { materialSince: input.observedAt, settleStartedAt: input.observedAt };
    }
    const materialSince =
      row.material_hash === input.materialHash ? row.material_since : input.observedAt;
    await sql`
      update pull_request_gate_states
      set material_hash = ${input.materialHash}, material_since = ${materialSince},
          updated_at = ${input.observedAt}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
    `.execute(transaction);
    return { materialSince, settleStartedAt: row.settle_started_at };
  });
}

export async function routePullRequestGateDecision(
  database: Kysely<DatabaseSchema>,
  input: {
    decision: PullRequestGateDecision;
    now: string;
    retryDueAt: string | null;
    workRef: WorkRef;
  },
): Promise<void> {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("pull_request_gate.time_invalid");
  if (input.decision.decision === "wait" && input.retryDueAt !== null) {
    const retryDueAt = Date.parse(input.retryDueAt);
    if (!Number.isFinite(retryDueAt) || retryDueAt <= Date.parse(input.now)) {
      throw new Error("pull_request_gate.retry_due_at_invalid");
    }
  }
  await database.transaction().execute(async (transaction) => {
    let mode: "AwaitingHuman" | "Ready" | "RetryQueued";
    let reason: string;
    let retryDueAt: string | null = null;
    let blockerPredicate: string | null = null;
    switch (input.decision.decision) {
      case "allow":
        mode = "Ready";
        reason = "review_required";
        break;
      case "update_required":
        mode = "Ready";
        reason = "base_update_required";
        break;
      case "deny":
        mode = "Ready";
        reason = `pull_request_rework_required:${encodeURIComponent(input.decision.reason)}`;
        break;
      case "wait":
        if (input.retryDueAt !== null) {
          mode = "RetryQueued";
          reason = "pull_request_hygiene_required";
          retryDueAt = input.retryDueAt;
        } else {
          mode = "AwaitingHuman";
          reason = "blocked";
          blockerPredicate = input.decision.reason;
        }
        break;
    }
    const claim = await sql`
      update claims
      set mode = ${mode}, reason = ${reason}, updated_at = ${input.now},
          retry_due_at = ${retryDueAt}, expires_at = null,
          blocker_predicate = ${blockerPredicate}, question_id = null,
          approval_request_id = null
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = 'pull_request_hygiene_required'
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("pull_request_gate.claim_not_ready");
    if (mode === "AwaitingHuman") {
      await sql`
        insert into parked_work (
          work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
          question_id, parked_at, last_checked_at, resolved_at
        ) values (
          ${input.workRef.kind}, ${input.workRef.id}, 'Review', 'blocked',
          ${blockerPredicate}, null, ${input.now}, ${input.now}, null
        )
        on conflict (work_ref_kind, work_ref_id) do update set
          origin_stage = excluded.origin_stage, reason = excluded.reason,
          blocker_predicate = excluded.blocker_predicate, question_id = null,
          parked_at = excluded.parked_at, last_checked_at = excluded.last_checked_at,
          resolved_at = null
      `.execute(transaction);
    }
  });
}
