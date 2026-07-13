import type { Claim } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface ClaimRow {
  acquired_at: string;
  approval_request_id: string | null;
  blocker_predicate: string | null;
  expires_at: string | null;
  holder: string;
  last_comment_cursor: string | null;
  mode: Claim["mode"];
  origin_stage: string;
  question_id: string | null;
  reason: string;
  retry_due_at: string | null;
  updated_at: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

export interface ClaimRecoveryState {
  awaitingHuman: Claim[];
  ready: Claim[];
  retries: Array<{ claim: Claim; delayMs: number }>;
  running: Array<{ claim: Claim; expired: boolean }>;
}

export async function loadClaimRecoveryState(
  database: Kysely<DatabaseSchema>,
  now: string,
): Promise<ClaimRecoveryState> {
  const nowMs = parseTimestamp(now, "claim.invalid_recovery_time");
  const result = await sql<ClaimRow>`
    select * from claims order by acquired_at, work_ref_kind, work_ref_id
  `.execute(database);
  const state: ClaimRecoveryState = { awaitingHuman: [], ready: [], retries: [], running: [] };
  for (const row of result.rows) {
    const claim = mapClaim(row);
    if (claim.mode === "Running") {
      state.running.push({
        claim,
        expired: parseTimestamp(claim.expires_at, "claim.invalid_expiry") <= nowMs,
      });
    } else if (claim.mode === "Ready") {
      state.ready.push(claim);
    } else if (claim.mode === "RetryQueued") {
      state.retries.push({
        claim,
        delayMs: Math.max(
          0,
          parseTimestamp(claim.retry_due_at, "claim.invalid_retry_due_at") - nowMs,
        ),
      });
    } else {
      state.awaitingHuman.push(claim);
    }
  }
  return state;
}

export async function renewRunningClaim(
  database: Kysely<DatabaseSchema>,
  input: {
    expectedExpiresAt: string;
    holder: string;
    newExpiresAt: string;
    renewedAt: string;
    workRef: { id: string; kind: "issue" | "system_job" };
  },
): Promise<void> {
  const expectedMs = parseTimestamp(input.expectedExpiresAt, "claim.invalid_expected_expiry");
  const renewedMs = parseTimestamp(input.renewedAt, "claim.invalid_renewal_time");
  const newExpiryMs = parseTimestamp(input.newExpiresAt, "claim.invalid_new_expiry");
  if (newExpiryMs <= expectedMs || expectedMs <= renewedMs) {
    throw new Error("claim.lease_not_renewable");
  }
  const update = await sql`
    update claims
    set expires_at = ${input.newExpiresAt}, updated_at = ${input.renewedAt}
    where work_ref_kind = ${input.workRef.kind}
      and work_ref_id = ${input.workRef.id}
      and holder = ${input.holder}
      and mode = 'Running'
      and expires_at = ${input.expectedExpiresAt}
      and expires_at > ${input.renewedAt}
  `.execute(database);
  if (update.numAffectedRows !== 1n) throw new Error("claim.lease_not_renewable");
}

function mapClaim(row: ClaimRow): Claim {
  const work_ref =
    row.work_ref_kind === "issue"
      ? ({ issue_id: row.work_ref_id } as const)
      : ({ system_job_id: row.work_ref_id } as const);
  const common = {
    acquired_at: row.acquired_at,
    approval_request_id: row.approval_request_id,
    blocker_predicate: row.blocker_predicate,
    holder: row.holder,
    last_comment_cursor: row.last_comment_cursor,
    origin_stage: row.origin_stage,
    question_id: row.question_id,
    reason: row.reason,
    updated_at: row.updated_at,
    work_ref,
  };
  if (row.mode === "Running" && row.expires_at !== null && row.retry_due_at === null) {
    return { ...common, expires_at: row.expires_at, mode: "Running", retry_due_at: null };
  }
  if (row.mode === "Ready" && row.expires_at === null && row.retry_due_at === null) {
    return { ...common, expires_at: null, mode: "Ready", retry_due_at: null };
  }
  if (row.mode === "RetryQueued" && row.expires_at === null && row.retry_due_at !== null) {
    return { ...common, expires_at: null, mode: "RetryQueued", retry_due_at: row.retry_due_at };
  }
  if (row.mode === "AwaitingHuman" && row.expires_at === null && row.retry_due_at === null) {
    return { ...common, expires_at: null, mode: "AwaitingHuman", retry_due_at: null };
  }
  throw new Error(`claim.invalid_persisted_mode:${row.work_ref_kind}:${row.work_ref_id}`);
}

function parseTimestamp(value: string, errorCode: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(errorCode);
  return parsed;
}
