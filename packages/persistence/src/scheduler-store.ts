import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { finishAttempt } from "./finish-attempt.js";
import { loadLatestHandoffForAttempt } from "./interrupted-attempt-recovery.js";

export interface RunningIssueAttemptRecord {
  attemptId: string;
  attemptLane: string;
  expectedExpiresAt: string;
  holder: string;
  issueId: string;
  lastEventAt: string;
  processGroupId: number;
  processId: number;
  workspacePath: string;
}

interface RunningIssueAttemptRow {
  attempt_id: string;
  expires_at: string;
  holder: string;
  last_event_at: string;
  process_group_id: number;
  process_id: number;
  stage: string;
  work_ref_id: string;
  workspace_path: string;
}

interface ReconciliationAttemptRow {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  role: string;
  system_job_status: string | null;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

interface ReconciliationLedgerRow {
  ledger_id: string;
  reservation_id: string;
  unit: "tokens" | "usd";
}

export async function countRunningClaims(database: Kysely<DatabaseSchema>): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*) as count from claims where mode = 'Running'
  `.execute(database);
  return result.rows[0]?.count ?? 0;
}

export async function isWorkClaimed(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<boolean> {
  const result = await sql<{ claimed: number }>`
    select exists(
      select 1 from claims
      where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
    ) as claimed
  `.execute(database);
  return result.rows[0]?.claimed === 1;
}

export async function listRunningIssueAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<RunningIssueAttemptRecord[]> {
  return listRunningAttempts(database, "issue");
}

export async function listRunningSystemJobAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<RunningIssueAttemptRecord[]> {
  return listRunningAttempts(database, "system_job");
}

async function listRunningAttempts(
  database: Kysely<DatabaseSchema>,
  workRefKind: "issue" | "system_job",
): Promise<RunningIssueAttemptRecord[]> {
  return database.transaction().execute(async (transaction) => {
    const expected = await sql<{ count: number }>`
      select count(*) as count from claims
      where mode = 'Running' and work_ref_kind = ${workRefKind}
    `.execute(transaction);
    const rows = await sql<RunningIssueAttemptRow>`
      select attempts.id as attempt_id, attempts.work_ref_id, attempts.workspace_path,
             claims.holder, claims.expires_at, live_sessions.last_event_at,
             live_sessions.process_id, live_sessions.process_group_id,
             stage_transitions.to_stage as stage
      from claims
      join attempts
        on attempts.work_ref_kind = claims.work_ref_kind
        and attempts.work_ref_id = claims.work_ref_id
        and attempts.status = 'running'
      join live_sessions on live_sessions.attempt_id = attempts.id
      join stage_transitions
        on stage_transitions.work_ref_kind = claims.work_ref_kind
        and stage_transitions.work_ref_id = claims.work_ref_id
        and stage_transitions.exited_at is null
      where claims.mode = 'Running' and claims.work_ref_kind = ${workRefKind}
      order by attempts.started_at, attempts.id
    `.execute(transaction);
    if (rows.rows.length !== (expected.rows[0]?.count ?? 0)) {
      throw new Error(`scheduler.running_${workRefKind}_identity_incomplete`);
    }
    return rows.rows.map((row) => ({
      attemptId: row.attempt_id,
      attemptLane: row.stage,
      expectedExpiresAt: row.expires_at,
      holder: row.holder,
      issueId: row.work_ref_id,
      lastEventAt: row.last_event_at,
      processGroupId: row.process_group_id,
      processId: row.process_id,
      workspacePath: row.workspace_path,
    }));
  });
}

export async function closeRunningAttemptForReconciliation(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    endedAt: string;
    failureClass: "agent_process" | "auth" | "configuration" | "infrastructure" | "policy" | "task";
    nextClaim:
      | { mode: "Ready"; reason: string }
      | { mode: "Released"; reason: string }
      | { dueAt: string; mode: "RetryQueued"; reason: string };
    summary: string;
    terminalResultId: string;
  },
): Promise<void> {
  if (!input.summary) throw new Error("scheduler.reconciliation_summary_missing");
  const attempts = await sql<ReconciliationAttemptRow>`
    select attempt.role, attempt.work_ref_kind, attempt.work_ref_id, attempt.input_tokens,
           attempt.output_tokens, attempt.cost_usd, job.status as system_job_status
    from attempts attempt
    left join system_jobs job
      on attempt.work_ref_kind = 'system_job' and job.id = attempt.work_ref_id
    where attempt.id = ${input.attemptId} and attempt.status = 'running'
  `.execute(database);
  const attempt = attempts.rows[0];
  if (!attempt) throw new Error(`scheduler.running_attempt_missing:${input.attemptId}`);
  if (attempt.work_ref_kind === "system_job" && !attempt.system_job_status) {
    throw new Error(`scheduler.running_system_job_missing:${input.attemptId}`);
  }
  const handoff = await loadLatestHandoffForAttempt(database, input.attemptId);
  const ledgers = await sql<ReconciliationLedgerRow>`
    select reservation.id as reservation_id, ledger.id as ledger_id, ledger.unit
    from budget_reservations reservation
    join budget_reservation_ledgers link on link.reservation_id = reservation.id
    join budget_ledgers ledger on ledger.id = link.ledger_id
    where reservation.attempt_id = ${input.attemptId} and reservation.status = 'reserved'
    order by ledger.id
  `.execute(database);
  const reservationIds = new Set(ledgers.rows.map((row) => row.reservation_id));
  if (reservationIds.size !== 1) {
    throw new Error(`scheduler.reservation_missing:${input.attemptId}`);
  }
  const totalTokens = attempt.input_tokens + attempt.output_tokens;
  const settledLedgers = ledgers.rows.map((ledger) => {
    if (ledger.unit === "usd" && attempt.cost_usd === null) {
      throw new Error(`scheduler.priced_usage_missing:${input.attemptId}`);
    }
    return {
      actualAmount: ledger.unit === "tokens" ? totalTokens : (attempt.cost_usd ?? 0),
      id: ledger.ledger_id,
    };
  });
  await finishAttempt(database, {
    attemptId: input.attemptId,
    costUsd: attempt.cost_usd,
    endedAt: input.endedAt,
    failureClass: input.failureClass,
    nextClaim: input.nextClaim,
    reservationId: reservationIds.values().next().value as string,
    settledLedgers,
    ...(attempt.work_ref_kind === "system_job"
      ? {
          systemJobStageTransition: {
            attemptId: input.attemptId,
            confirmedExternalRevision: null,
            enteredAt: input.endedAt,
            expectedFromStage: attempt.system_job_status as string,
            id: `${input.terminalResultId}:stage`,
            reason: `reconciliation.${input.nextClaim.reason}`,
            timestampSource: "observed_estimate" as const,
            toStage: input.nextClaim.mode === "Released" ? "failed" : "rework",
            workRef: { id: attempt.work_ref_id, kind: "system_job" as const },
          },
        }
      : {}),
    terminalResult: {
      id: input.terminalResultId,
      kind: "execution_failure",
      payload: {
        evidence: [],
        failure_class: input.failureClass,
        handoff,
        role: attempt.role,
        status: "failed",
        summary: input.summary,
      },
      role: attempt.role,
    },
    usage: { inputTokens: attempt.input_tokens, outputTokens: attempt.output_tokens },
    workRef: { id: attempt.work_ref_id, kind: attempt.work_ref_kind },
  });
}
