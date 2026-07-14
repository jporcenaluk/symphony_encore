import { type Handoff, isHandoff } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { finishAttemptInTransaction } from "./finish-attempt.js";

type OwnershipEvidence =
  | { kind: "no_session"; verifiedAt: string }
  | {
      kind: "terminated";
      processGroupId: number;
      processId: number;
      verifiedAt: string;
    };

export interface RecoverInterruptedAttemptInput {
  attemptId: string;
  endedAt: string;
  latestHandoff: Handoff;
  ownership: OwnershipEvidence;
  terminalResultId: string;
}

interface AttemptRecoveryRow {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  role: string;
  status: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

interface SessionRecoveryRow {
  process_group_id: number;
  process_id: number;
}

interface RecoveryLedgerRow {
  ledger_id: string;
  reservation_id: string;
  unit: "tokens" | "usd";
}

interface InterruptedAttemptRow {
  attempt_id: string;
  process_group_id: number | null;
  process_id: number | null;
}

interface AttemptWorkRow {
  attempt_number: number;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

interface HandoffPayloadRow {
  payload_json: string;
}

interface IssueHandoffRow {
  acceptance_criteria_json: string;
  provider_revision: string;
  title: string;
}

interface SystemJobHandoffRow {
  acceptance_criteria_json: string;
  config_snapshot_id: string;
  goal: string;
}

export interface InterruptedAttempt {
  attemptId: string;
  processGroupId: number | null;
  processId: number | null;
}

export async function listInterruptedAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<InterruptedAttempt[]> {
  const result = await sql<InterruptedAttemptRow>`
    select attempts.id as attempt_id, live_sessions.process_id, live_sessions.process_group_id
    from attempts
    left join live_sessions on live_sessions.attempt_id = attempts.id
    where attempts.status in ('created', 'running', 'awaiting_human')
    order by attempts.started_at, attempts.id
  `.execute(database);
  return result.rows.map((row) => ({
    attemptId: row.attempt_id,
    processGroupId: row.process_group_id,
    processId: row.process_id,
  }));
}

export async function loadLatestHandoffForAttempt(
  database: Kysely<DatabaseSchema>,
  attemptId: string,
): Promise<Handoff> {
  const attempts = await sql<AttemptWorkRow>`
    select work_ref_kind, work_ref_id, attempt_number
    from attempts where id = ${attemptId}
  `.execute(database);
  const attempt = attempts.rows[0];
  if (!attempt) throw new Error(`recovery.attempt_not_found:${attemptId}`);

  const prior = await sql<HandoffPayloadRow>`
    select terminal_results.payload_json
    from attempts prior
    join terminal_results on terminal_results.attempt_id = prior.id
    where prior.work_ref_kind = ${attempt.work_ref_kind}
      and prior.work_ref_id = ${attempt.work_ref_id}
      and prior.attempt_number < ${attempt.attempt_number}
      and json_type(terminal_results.payload_json, '$.handoff') = 'object'
    order by prior.attempt_number desc, terminal_results.created_at desc
    limit 1
  `.execute(database);
  const payload = prior.rows[0];
  if (payload) {
    const parsed = JSON.parse(payload.payload_json) as { handoff?: unknown };
    if (!isHandoff(parsed.handoff)) {
      throw new Error(`recovery.invalid_handoff:${attemptId}`);
    }
    return parsed.handoff;
  }

  const openItems = ["Resume work from the durable workspace after process interruption"];
  if (attempt.work_ref_kind === "issue") {
    const issues = await sql<IssueHandoffRow>`
      select title, acceptance_criteria_json, provider_revision
      from issues where id = ${attempt.work_ref_id}
    `.execute(database);
    const issue = issues.rows[0];
    if (!issue) throw new Error(`recovery.issue_snapshot_missing:${attempt.work_ref_id}`);
    return {
      acceptance_criteria: parseCriteria(issue.acceptance_criteria_json, attemptId),
      commands: [],
      decisions_fixed: [],
      files_changed: [],
      goal: issue.title,
      open_items: openItems,
      revision: issue.provider_revision,
    };
  }

  const jobs = await sql<SystemJobHandoffRow>`
    select goal, acceptance_criteria_json, config_snapshot_id
    from system_jobs where id = ${attempt.work_ref_id}
  `.execute(database);
  const job = jobs.rows[0];
  if (!job) throw new Error(`recovery.system_job_missing:${attempt.work_ref_id}`);
  return {
    acceptance_criteria: parseCriteria(job.acceptance_criteria_json, attemptId),
    commands: [],
    decisions_fixed: [],
    files_changed: [],
    goal: job.goal,
    open_items: openItems,
    revision: job.config_snapshot_id,
  };
}

export async function markLiveSessionOwnershipVerified(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    processGroupId: number;
    processId: number;
    verifiedAt: string;
  },
): Promise<void> {
  const result = await sql`
    update live_sessions set ownership_verified_at = ${input.verifiedAt}
    where attempt_id = ${input.attemptId}
      and process_id = ${input.processId}
      and process_group_id = ${input.processGroupId}
  `.execute(database);
  if (result.numAffectedRows !== 1n) {
    throw new Error(`recovery.process_identity_mismatch:${input.attemptId}`);
  }
}

export async function recoverInterruptedAttempt(
  database: Kysely<DatabaseSchema>,
  input: RecoverInterruptedAttemptInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const attempts = await sql<AttemptRecoveryRow>`
      select role, status, work_ref_kind, work_ref_id,
             input_tokens, output_tokens, cost_usd
      from attempts where id = ${input.attemptId}
    `.execute(transaction);
    const attempt = attempts.rows[0];
    if (
      attempt === undefined ||
      !["created", "running", "awaiting_human"].includes(attempt.status)
    ) {
      throw new Error(`recovery.attempt_not_open:${input.attemptId}`);
    }

    const sessions = await sql<SessionRecoveryRow>`
      select process_id, process_group_id
      from live_sessions where attempt_id = ${input.attemptId}
    `.execute(transaction);
    const session = sessions.rows[0];
    if (input.ownership.kind === "no_session") {
      if (session !== undefined) throw new Error("recovery.process_identity_mismatch");
    } else {
      if (
        session === undefined ||
        session.process_id !== input.ownership.processId ||
        session.process_group_id !== input.ownership.processGroupId
      ) {
        throw new Error("recovery.process_identity_mismatch");
      }
      const ownership = await sql`
        update live_sessions set ownership_verified_at = ${input.ownership.verifiedAt}
        where attempt_id = ${input.attemptId}
          and process_id = ${input.ownership.processId}
          and process_group_id = ${input.ownership.processGroupId}
      `.execute(transaction);
      if (ownership.numAffectedRows !== 1n) {
        throw new Error("recovery.process_identity_mismatch");
      }
    }

    const ledgers = await sql<RecoveryLedgerRow>`
      select reservation.id as reservation_id, ledger.id as ledger_id, ledger.unit
      from budget_reservations reservation
      join budget_reservation_ledgers link on link.reservation_id = reservation.id
      join budget_ledgers ledger on ledger.id = link.ledger_id
      where reservation.attempt_id = ${input.attemptId}
        and reservation.status = 'reserved'
      order by ledger.id
    `.execute(transaction);
    const reservationIds = new Set(ledgers.rows.map((row) => row.reservation_id));
    if (reservationIds.size !== 1) {
      throw new Error(`recovery.reservation_missing:${input.attemptId}`);
    }
    const totalTokens = attempt.input_tokens + attempt.output_tokens;
    const settledLedgers = ledgers.rows.map((ledger) => {
      if (ledger.unit === "usd" && attempt.cost_usd === null) {
        throw new Error(`recovery.priced_usage_missing:${input.attemptId}`);
      }
      return {
        actualAmount: ledger.unit === "tokens" ? totalTokens : (attempt.cost_usd ?? 0),
        id: ledger.ledger_id,
      };
    });

    await finishAttemptInTransaction(transaction, {
      attemptId: input.attemptId,
      costUsd: attempt.cost_usd,
      endedAt: input.endedAt,
      failureClass: "agent_process",
      nextClaim: { mode: "Ready", reason: "restart_interrupted_attempt" },
      reservationId: reservationIds.values().next().value as string,
      settledLedgers,
      terminalResult: {
        id: input.terminalResultId,
        kind: "execution_failure",
        payload: {
          evidence: [],
          failure_class: "agent_process",
          handoff: input.latestHandoff,
          role: attempt.role,
          status: "failed",
          summary: "Attempt interrupted during service restart",
        },
        role: attempt.role,
      },
      usage: { inputTokens: attempt.input_tokens, outputTokens: attempt.output_tokens },
      workRef: { id: attempt.work_ref_id, kind: attempt.work_ref_kind },
    });
  });
}

function parseCriteria(value: string, attemptId: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((criterion) => typeof criterion !== "string" || criterion.length === 0)
  ) {
    throw new Error(`recovery.invalid_acceptance_criteria:${attemptId}`);
  }
  return parsed;
}
