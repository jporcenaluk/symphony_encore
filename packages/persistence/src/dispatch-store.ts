import type { MutationAuthorization, SideEffectIntent } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { type AppendEventRecordInput, appendEventRecordInTransaction } from "./event-store.js";
import { createAuthorizedIntentInTransaction } from "./side-effect-store.js";
import { type StageTransitionInput, transitionStageInTransaction } from "./stage-transition.js";

export interface DispatchInput {
  attempt: {
    attemptNumber: number;
    changeClass: "trivial" | "standard" | "high_risk";
    computeProfile: "economy" | "standard" | "deep";
    configSnapshotId: string;
    costUsd: number | null;
    id: string;
    model: string;
    priceTableVersion: string | null;
    reasoningEffort: string;
    role:
      | "plan_review"
      | "implementation"
      | "integrative_review"
      | "specialist_review"
      | "adjudication"
      | "synthesis";
    routingReasons: readonly string[];
    startedAt: string;
    workspacePath: string;
  };
  claim: {
    acquiredAt: string;
    expiresAt: string;
    holder: string;
    originStage: string;
    reason: string;
  };
  issueMutation?: {
    authorization: MutationAuthorization;
    event: AppendEventRecordInput;
    intent: SideEffectIntent;
  };
  reservation: {
    id: string;
    ledgers: readonly { amount: number; id: string; version: number }[];
  };
  systemJobTransition?: StageTransitionInput;
  workRef: { kind: "issue" | "system_job"; id: string };
}

export async function createDispatch(
  database: Kysely<DatabaseSchema>,
  input: DispatchInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
      ) values (
        ${input.attempt.id}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attempt.role},
        ${input.attempt.attemptNumber}, ${input.attempt.workspacePath},
        ${input.attempt.configSnapshotId}, ${input.attempt.computeProfile}, ${input.attempt.model},
        ${input.attempt.reasoningEffort}, ${input.attempt.priceTableVersion},
        ${JSON.stringify(input.attempt.routingReasons)}, ${input.attempt.changeClass},
        ${input.attempt.startedAt}, null, 'created', null, null, 0, 0, 0, ${input.attempt.costUsd}
      )
    `.execute(transaction);
    await sql`
      insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason, retry_due_at, blocker_predicate,
        question_id, approval_request_id, last_comment_cursor
      ) values (
        ${input.workRef.kind}, ${input.workRef.id}, ${input.claim.holder}, 'Running',
        ${input.claim.acquiredAt}, ${input.claim.acquiredAt}, ${input.claim.expiresAt},
        ${input.claim.originStage}, ${input.claim.reason}, null, null, null, null, null
      )
    `.execute(transaction);
    await sql`
      insert into budget_reservations (
        id, work_ref_kind, work_ref_id, attempt_id, system_job_id,
        estimated_amounts_json, actual_amounts_json, status, created_at, updated_at
      ) values (
        ${input.reservation.id}, ${input.workRef.kind}, ${input.workRef.id},
        ${input.attempt.id}, null, ${JSON.stringify(
          Object.fromEntries(input.reservation.ledgers.map((ledger) => [ledger.id, ledger.amount])),
        )}, '{}', 'reserved', ${input.claim.acquiredAt}, ${input.claim.acquiredAt}
      )
    `.execute(transaction);

    for (const ledger of input.reservation.ledgers) {
      const update = await sql`
        update budget_ledgers
        set reserved = reserved + ${ledger.amount}, version = version + 1,
            updated_at = ${input.claim.acquiredAt}
        where id = ${ledger.id}
          and version = ${ledger.version}
          and effective_limit - consumed - reserved >= ${ledger.amount}
      `.execute(transaction);
      if (update.numAffectedRows !== 1n) {
        throw new Error(`Budget reservation denied for ledger ${ledger.id}`);
      }
      await sql`
        insert into budget_reservation_ledgers (reservation_id, ledger_id, reserved_amount)
        values (${input.reservation.id}, ${ledger.id}, ${ledger.amount})
      `.execute(transaction);
    }

    if (input.issueMutation && input.systemJobTransition) {
      throw new Error("dispatch.multiple_stage_mutations");
    }
    if (input.issueMutation) {
      if (input.workRef.kind !== "issue") {
        throw new Error("dispatch.issue_mutation_requires_issue_work_ref");
      }
      await createAuthorizedIntentInTransaction(transaction, {
        authorization: input.issueMutation.authorization,
        intent: input.issueMutation.intent,
      });
      await appendEventRecordInTransaction(transaction, input.issueMutation.event);
    }
    if (input.systemJobTransition) {
      if (
        input.workRef.kind !== "system_job" ||
        input.systemJobTransition.workRef.kind !== "system_job" ||
        input.systemJobTransition.workRef.id !== input.workRef.id ||
        input.systemJobTransition.attemptId !== input.attempt.id ||
        input.systemJobTransition.expectedFromStage !== "queued" ||
        input.systemJobTransition.toStage !== "running"
      ) {
        throw new Error("dispatch.invalid_system_job_transition");
      }
      const update = await sql`
        update system_jobs
        set status = 'running', started_at = ${input.systemJobTransition.enteredAt}
        where id = ${input.workRef.id} and status = 'queued' and started_at is null
      `.execute(transaction);
      if (update.numAffectedRows !== 1n) {
        throw new Error("dispatch.system_job_not_queued");
      }
      await transitionStageInTransaction(transaction, input.systemJobTransition);
    }
  });
}
