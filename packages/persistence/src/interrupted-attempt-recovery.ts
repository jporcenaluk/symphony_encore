import type { Handoff } from "@symphony/contracts";
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
