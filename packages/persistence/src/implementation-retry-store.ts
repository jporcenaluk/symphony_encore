import {
  type ExecutionFailure,
  type Handoff,
  type ImplementationOutcome,
  isExecutionFailure,
  isImplementationOutcome,
} from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export type ImplementationRetryReason =
  | "implementation_rework"
  | "no_progress_retry"
  | "implementation_failed"
  | "launch_failed"
  | "restart_interrupted_attempt"
  | "response_timeout"
  | "turn_timeout"
  | "stalled"
  | "process_exit"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "result_missing"
  | "result_invalid"
  | "overloaded";

export interface PendingImplementationRetry {
  changeClass: "standard" | "high_risk";
  configSnapshotId: string;
  handoff: Handoff;
  reason: ImplementationRetryReason;
  routingFacts: readonly string[];
  source: ImplementationOutcome | ExecutionFailure;
  workspacePath: string;
}

interface RetryRow {
  change_class: PendingImplementationRetry["changeClass"];
  config_snapshot_id: string;
  payload_json: string;
  reason: string;
  result_kind: string;
  routing_reasons_json: string;
  workspace_path: string;
}

const FAILURE_REASONS = new Set<ImplementationRetryReason>([
  "launch_failed",
  "restart_interrupted_attempt",
  "response_timeout",
  "turn_timeout",
  "stalled",
  "process_exit",
  "turn_failed",
  "turn_cancelled",
  "turn_input_required",
  "result_missing",
  "result_invalid",
  "overloaded",
]);

export function isImplementationRetryReason(value: string): value is ImplementationRetryReason {
  return (
    value === "implementation_rework" ||
    value === "no_progress_retry" ||
    value === "implementation_failed" ||
    FAILURE_REASONS.has(value as ImplementationRetryReason)
  );
}

export async function loadPendingImplementationRetry(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<PendingImplementationRetry | null> {
  const query = await sql<RetryRow>`
    select attempt.change_class, attempt.config_snapshot_id, attempt.workspace_path,
           attempt.routing_reasons_json, claim.reason, result.result_kind, result.payload_json
    from claims claim
    join attempts attempt
      on attempt.work_ref_kind = claim.work_ref_kind
      and attempt.work_ref_id = claim.work_ref_id
      and attempt.role = 'implementation'
      and attempt.status = 'closed'
    join terminal_results result
      on result.id = attempt.terminal_result_id
      and result.attempt_id = attempt.id
      and result.role = 'implementation'
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
    order by attempt.attempt_number desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  if (!row) return null;
  const reason = retryReason(row.reason);
  const routingFacts = parseStringList(row.routing_reasons_json);
  const payload: unknown = JSON.parse(row.payload_json);
  const source = retrySource(row.result_kind, payload, reason);
  return {
    changeClass: row.change_class,
    configSnapshotId: row.config_snapshot_id,
    handoff: source.handoff,
    reason,
    routingFacts,
    source,
    workspacePath: row.workspace_path,
  };
}

function retrySource(
  resultKind: string,
  payload: unknown,
  reason: ImplementationRetryReason,
): ImplementationOutcome | ExecutionFailure {
  if (resultKind === "implementation_outcome" && isImplementationOutcome(payload)) {
    const expected =
      payload.status === "needs_rework"
        ? "implementation_rework"
        : payload.status === "no_progress"
          ? "no_progress_retry"
          : payload.status === "failed"
            ? "implementation_failed"
            : null;
    if (reason === expected) return payload;
  }
  if (
    resultKind === "execution_failure" &&
    isExecutionFailure(payload) &&
    payload.role === "implementation" &&
    payload.status === "failed" &&
    FAILURE_REASONS.has(reason)
  ) {
    return payload;
  }
  throw new Error("implementation_retry.persisted_source_mismatch");
}

function retryReason(value: string): ImplementationRetryReason {
  if (isImplementationRetryReason(value)) return value;
  throw new Error(`implementation_retry.reason_unsupported:${value}`);
}

function parseStringList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("implementation_retry.persisted_routing_facts_invalid");
  }
  return parsed;
}
