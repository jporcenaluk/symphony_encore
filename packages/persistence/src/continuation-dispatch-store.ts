import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import type { DispatchInput } from "./dispatch-store.js";

export async function createContinuationDispatch(
  database: Kysely<DatabaseSchema>,
  input: { dispatch: DispatchInput; expectedReadyReason: string },
): Promise<void> {
  const dispatch = input.dispatch;
  if (dispatch.issueMutation || dispatch.systemJobTransition) {
    throw new Error("continuation_dispatch.external_transition_forbidden");
  }
  await database.transaction().execute(async (transaction) => {
    const claim = await sql`
      update claims
      set holder = ${dispatch.claim.holder}, mode = 'Running',
          acquired_at = ${dispatch.claim.acquiredAt}, updated_at = ${dispatch.claim.acquiredAt},
          expires_at = ${dispatch.claim.expiresAt}, reason = ${dispatch.claim.reason},
          retry_due_at = null, blocker_predicate = null, question_id = null,
          approval_request_id = null
      where work_ref_kind = ${dispatch.workRef.kind}
        and work_ref_id = ${dispatch.workRef.id}
        and mode = 'Ready'
        and reason = ${input.expectedReadyReason}
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) {
      throw new Error("continuation_dispatch.claim_not_ready");
    }
    await sql`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
      ) values (
        ${dispatch.attempt.id}, ${dispatch.workRef.kind}, ${dispatch.workRef.id},
        ${dispatch.attempt.role}, ${dispatch.attempt.attemptNumber},
        ${dispatch.attempt.workspacePath}, ${dispatch.attempt.configSnapshotId},
        ${dispatch.attempt.computeProfile}, ${dispatch.attempt.model},
        ${dispatch.attempt.reasoningEffort}, ${dispatch.attempt.priceTableVersion},
        ${JSON.stringify(dispatch.attempt.routingReasons)}, ${dispatch.attempt.changeClass},
        ${dispatch.attempt.startedAt}, null, 'created', null, null, 0, 0, 0,
        ${dispatch.attempt.costUsd}
      )
    `.execute(transaction);
    await sql`
      insert into budget_reservations (
        id, work_ref_kind, work_ref_id, attempt_id, system_job_id,
        estimated_amounts_json, actual_amounts_json, status, created_at, updated_at
      ) values (
        ${dispatch.reservation.id}, ${dispatch.workRef.kind}, ${dispatch.workRef.id},
        ${dispatch.attempt.id}, null,
        ${JSON.stringify(
          Object.fromEntries(
            dispatch.reservation.ledgers.map((ledger) => [ledger.id, ledger.amount]),
          ),
        )}, '{}', 'reserved', ${dispatch.claim.acquiredAt}, ${dispatch.claim.acquiredAt}
      )
    `.execute(transaction);
    for (const ledger of dispatch.reservation.ledgers) {
      const update = await sql`
        update budget_ledgers
        set reserved = reserved + ${ledger.amount}, version = version + 1,
            updated_at = ${dispatch.claim.acquiredAt}
        where id = ${ledger.id}
          and version = ${ledger.version}
          and effective_limit - consumed - reserved >= ${ledger.amount}
      `.execute(transaction);
      if (update.numAffectedRows !== 1n) {
        throw new Error(`Budget reservation denied for ledger ${ledger.id}`);
      }
      await sql`
        insert into budget_reservation_ledgers (reservation_id, ledger_id, reserved_amount)
        values (${dispatch.reservation.id}, ${ledger.id}, ${ledger.amount})
      `.execute(transaction);
    }
  });
}
