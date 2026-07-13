import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface SettlementInput {
  actualAmount: number;
  id: string;
}

type NextClaim =
  | { mode: "Released"; reason: string }
  | { mode: "Ready"; reason: string }
  | { dueAt: string; mode: "RetryQueued"; reason: string }
  | {
      approvalRequestId: string | null;
      blockerPredicate: string | null;
      mode: "AwaitingHuman";
      questionId: string | null;
      reason: string;
    };

export interface FinishAttemptInput {
  attemptId: string;
  costUsd: number | null;
  endedAt: string;
  failureClass: string | null;
  nextClaim: NextClaim;
  reservationId: string;
  settledLedgers: readonly SettlementInput[];
  terminalResult: {
    id: string;
    kind: string;
    payload: unknown;
    role: string;
  };
  usage: { inputTokens: number; outputTokens: number };
  workRef: { id: string; kind: "issue" | "system_job" };
}

interface ReservationLedgerRow {
  ledger_id: string;
  reserved_amount: number;
}

export async function finishAttempt(
  database: Kysely<DatabaseSchema>,
  input: FinishAttemptInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await finishAttemptInTransaction(transaction, input);
  });
}

export async function finishAttemptInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: FinishAttemptInput,
): Promise<void> {
  const close = await sql`
      update attempts
      set ended_at = ${input.endedAt}, status = 'closed',
          terminal_result_id = ${input.terminalResult.id}, failure_class = ${input.failureClass},
          input_tokens = ${input.usage.inputTokens}, output_tokens = ${input.usage.outputTokens},
          total_tokens = ${input.usage.inputTokens + input.usage.outputTokens},
          cost_usd = ${input.costUsd}
      where id = ${input.attemptId}
        and work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and status != 'closed'
        and terminal_result_id is null
    `.execute(transaction);
  if (close.numAffectedRows !== 1n) {
    throw new Error(`Attempt ${input.attemptId} is already closed or missing`);
  }

  await sql`
      insert into terminal_results (id, attempt_id, role, result_kind, payload_json, created_at)
      values (
        ${input.terminalResult.id}, ${input.attemptId}, ${input.terminalResult.role},
        ${input.terminalResult.kind}, ${JSON.stringify(input.terminalResult.payload)}, ${input.endedAt}
      )
    `.execute(transaction);

  const links = await sql<ReservationLedgerRow>`
      select ledger_id, reserved_amount
      from budget_reservation_ledgers
      where reservation_id = ${input.reservationId}
      order by ledger_id
    `.execute(transaction);
  const settlements = new Map(input.settledLedgers.map((entry) => [entry.id, entry.actualAmount]));
  if (
    settlements.size !== input.settledLedgers.length ||
    links.rows.length !== settlements.size ||
    links.rows.some((link) => !settlements.has(link.ledger_id))
  ) {
    throw new Error(`Reservation ${input.reservationId} ledger settlement does not match`);
  }

  let hasOverrun = false;
  for (const link of links.rows) {
    const actualAmount = settlements.get(link.ledger_id);
    if (actualAmount === undefined || actualAmount < 0) {
      throw new Error(`Invalid actual amount for ledger ${link.ledger_id}`);
    }
    if (actualAmount > link.reserved_amount) hasOverrun = true;
    const update = await sql`
        update budget_ledgers
        set reserved = reserved - ${link.reserved_amount},
            consumed = consumed + ${actualAmount},
            overrun = max(overrun, max(0, consumed + ${actualAmount} - effective_limit)),
            version = version + 1,
            updated_at = ${input.endedAt}
        where id = ${link.ledger_id} and reserved >= ${link.reserved_amount}
      `.execute(transaction);
    if (update.numAffectedRows !== 1n) {
      throw new Error(`Ledger ${link.ledger_id} cannot settle reservation ${input.reservationId}`);
    }
  }

  const reservation = await sql`
      update budget_reservations
      set actual_amounts_json = ${JSON.stringify(Object.fromEntries(settlements))},
          status = ${hasOverrun ? "overrun" : "settled"}, updated_at = ${input.endedAt}
      where id = ${input.reservationId} and status = 'reserved'
    `.execute(transaction);
  if (reservation.numAffectedRows !== 1n) {
    throw new Error(`Reservation ${input.reservationId} is already settled or missing`);
  }

  const claim =
    input.nextClaim.mode === "Released"
      ? await sql`
          delete from claims
          where work_ref_kind = ${input.workRef.kind}
            and work_ref_id = ${input.workRef.id}
            and mode = 'Running'
        `.execute(transaction)
      : await sql`
          update claims
          set mode = ${input.nextClaim.mode}, updated_at = ${input.endedAt}, expires_at = null,
              reason = ${input.nextClaim.reason},
              retry_due_at = ${
                input.nextClaim.mode === "RetryQueued" ? input.nextClaim.dueAt : null
              },
              question_id = ${
                input.nextClaim.mode === "AwaitingHuman" ? input.nextClaim.questionId : null
              },
              approval_request_id = ${
                input.nextClaim.mode === "AwaitingHuman" ? input.nextClaim.approvalRequestId : null
              },
              blocker_predicate = ${
                input.nextClaim.mode === "AwaitingHuman" ? input.nextClaim.blockerPredicate : null
              }
          where work_ref_kind = ${input.workRef.kind}
            and work_ref_id = ${input.workRef.id}
            and mode = 'Running'
        `.execute(transaction);
  if (claim.numAffectedRows !== 1n) {
    throw new Error(`Running claim for ${input.workRef.kind}:${input.workRef.id} is missing`);
  }
}
