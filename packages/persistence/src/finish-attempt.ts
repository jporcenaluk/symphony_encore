import { isImplementationOutcome } from "@symphony/contracts";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { type StageTransitionInput, transitionStageInTransaction } from "./stage-transition.js";

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
  parkedOriginStage?: string;
  reservationId: string;
  retryEntry?: {
    dueAt: string;
    failureClass: string;
    lastError: string;
    maxRetries: number;
    retryNumber: number;
  };
  settledLedgers: readonly SettlementInput[];
  systemJobStageTransition?: StageTransitionInput;
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

interface AttemptSettlementRow {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
}

interface ImplementationOutcomeRow {
  payload_json: string;
}

interface FailureRetryStateRow {
  agent_process_failures: number;
  infrastructure_failures: number;
  retry_entries: number;
  first_infrastructure_failure_at: string | null;
}

export interface FailureRetryState {
  agentProcessFailures: number;
  firstInfrastructureFailureAt: string | null;
  infrastructureFailures: number;
  retryEntries: number;
}

export async function loadFailureRetryState(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<FailureRetryState> {
  const query = await sql<FailureRetryStateRow>`
    select
      (select count(*) from attempts
       where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
         and role = 'implementation' and status = 'closed'
         and failure_class = 'agent_process') as agent_process_failures,
      (select count(*) from attempts
       where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
         and role = 'implementation' and status = 'closed'
         and failure_class = 'infrastructure') as infrastructure_failures,
      (select count(*) from retry_entries
       where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}) as retry_entries,
      (select min(created_at) from retry_entries
       where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
         and failure_class = 'infrastructure') as first_infrastructure_failure_at
  `.execute(database);
  const row = query.rows[0];
  if (!row) throw new Error("retry.state_missing");
  return {
    agentProcessFailures: row.agent_process_failures,
    firstInfrastructureFailureAt: row.first_infrastructure_failure_at,
    infrastructureFailures: row.infrastructure_failures,
    retryEntries: row.retry_entries,
  };
}

export async function loadImplementationOutcomeCounts(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<{ noProgress: number; rework: number }> {
  const query = await sql<ImplementationOutcomeRow>`
    select result.payload_json
    from terminal_results result
    join attempts attempt on attempt.id = result.attempt_id
    where attempt.work_ref_kind = ${workRef.kind}
      and attempt.work_ref_id = ${workRef.id}
      and attempt.role = 'implementation'
      and attempt.status = 'closed'
      and result.role = 'implementation'
      and result.result_kind = 'implementation_outcome'
    order by attempt.attempt_number
  `.execute(database);
  let noProgress = 0;
  let rework = 0;
  for (const row of query.rows) {
    const outcome: unknown = JSON.parse(row.payload_json);
    if (!isImplementationOutcome(outcome)) {
      throw new Error("attempt.persisted_implementation_outcome_invalid");
    }
    if (outcome.status === "no_progress") noProgress += 1;
    if (outcome.status === "needs_rework") rework += 1;
  }
  return { noProgress, rework };
}

interface SettlementLedgerRow {
  ledger_id: string;
  unit: "tokens" | "usd";
}

export interface AttemptSettlementState {
  costUsd: number | null;
  inputTokens: number;
  ledgers: readonly { id: string; unit: "tokens" | "usd" }[];
  outputTokens: number;
}

export async function loadAttemptSettlementState(
  database: Kysely<DatabaseSchema>,
  input: { attemptId: string; reservationId: string },
): Promise<AttemptSettlementState> {
  const attempts = await sql<AttemptSettlementRow>`
    select attempts.input_tokens, attempts.output_tokens, attempts.cost_usd
    from attempts
    join budget_reservations
      on budget_reservations.attempt_id = attempts.id
      and budget_reservations.id = ${input.reservationId}
      and budget_reservations.status = 'reserved'
    where attempts.id = ${input.attemptId} and attempts.status != 'closed'
  `.execute(database);
  const attempt = attempts.rows[0];
  if (!attempt) throw new Error(`Attempt ${input.attemptId} is not open with a reservation`);
  const ledgers = await sql<SettlementLedgerRow>`
    select links.ledger_id, ledgers.unit
    from budget_reservation_ledgers as links
    join budget_ledgers as ledgers on ledgers.id = links.ledger_id
    where links.reservation_id = ${input.reservationId}
    order by links.ledger_id
  `.execute(database);
  if (ledgers.rows.length === 0) {
    throw new Error(`Reservation ${input.reservationId} has no ledgers`);
  }
  return {
    costUsd: attempt.cost_usd,
    inputTokens: attempt.input_tokens,
    ledgers: ledgers.rows.map((ledger) => ({ id: ledger.ledger_id, unit: ledger.unit })),
    outputTokens: attempt.output_tokens,
  };
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

  if (input.workRef.kind === "system_job") {
    const aggregate = await sql`
      update system_jobs
      set input_tokens = input_tokens + ${input.usage.inputTokens},
          output_tokens = output_tokens + ${input.usage.outputTokens},
          cost_usd = case
            when ${input.costUsd} is null then cost_usd
            else coalesce(cost_usd, 0) + ${input.costUsd}
          end
      where id = ${input.workRef.id}
    `.execute(transaction);
    if (aggregate.numAffectedRows !== 1n) throw new Error("attempt.system_job_missing");
  }
  if (input.systemJobStageTransition) {
    const transition = input.systemJobStageTransition;
    if (
      input.workRef.kind !== "system_job" ||
      transition.workRef.kind !== "system_job" ||
      transition.workRef.id !== input.workRef.id ||
      transition.attemptId !== input.attemptId ||
      !isSystemJobStatus(transition.toStage)
    ) {
      throw new Error("attempt.system_job_transition_invalid");
    }
    const job = await sql`
      update system_jobs
      set status = ${transition.toStage},
          ended_at = case when ${transition.toStage} in ('done', 'failed') then ${input.endedAt} else ended_at end,
          final_result_id = case
            when ${transition.toStage} in ('done', 'failed') then ${input.terminalResult.id}
            else final_result_id
          end
      where id = ${input.workRef.id} and status = ${transition.expectedFromStage}
    `.execute(transaction);
    if (job.numAffectedRows !== 1n) throw new Error("attempt.system_job_stage_mismatch");
    await transitionStageInTransaction(transaction, transition);
  }

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

  if (input.retryEntry) {
    if (
      input.nextClaim.mode !== "RetryQueued" ||
      input.nextClaim.dueAt !== input.retryEntry.dueAt ||
      input.retryEntry.retryNumber < 1 ||
      input.retryEntry.maxRetries < 0 ||
      !input.retryEntry.lastError
    ) {
      throw new Error("retry.entry_invalid");
    }
    await sql`
      insert into retry_entries (
        work_ref_kind, work_ref_id, attempt_id, failure_class, retry_number,
        due_at, max_retries, last_error, created_at
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
        ${input.retryEntry.failureClass}, ${input.retryEntry.retryNumber},
        ${input.retryEntry.dueAt}, ${input.retryEntry.maxRetries},
        ${input.retryEntry.lastError}, ${input.endedAt}
      )
    `.execute(transaction);
  } else if (input.nextClaim.mode === "RetryQueued") {
    throw new Error("retry.entry_missing");
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
  if (input.nextClaim.mode === "AwaitingHuman" && input.parkedOriginStage) {
    await sql`
      insert into parked_work (
        work_ref_kind, work_ref_id, origin_stage, reason, blocker_predicate,
        question_id, parked_at, last_checked_at, resolved_at
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, ${input.parkedOriginStage},
        ${input.nextClaim.reason}, ${input.nextClaim.blockerPredicate},
        ${input.nextClaim.questionId}, ${input.endedAt}, ${input.endedAt}, null
      )
      on conflict (work_ref_kind, work_ref_id) do update set
        origin_stage = excluded.origin_stage, reason = excluded.reason,
        blocker_predicate = excluded.blocker_predicate, question_id = excluded.question_id,
        parked_at = excluded.parked_at, last_checked_at = excluded.last_checked_at,
        resolved_at = null
    `.execute(transaction);
  }
}

function isSystemJobStatus(value: string): boolean {
  return [
    "queued",
    "running",
    "review",
    "merge",
    "rework",
    "human",
    "budget_exhausted",
    "failed",
    "done",
  ].includes(value);
}
