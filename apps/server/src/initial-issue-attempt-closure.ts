import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type ImplementationOutcome,
  type Issue,
  isImplementationOutcome,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  finishAttempt,
  loadAttemptSettlementState,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";

export async function closeInitialIssueAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  database: OpenedDatabase["database"];
  endedAt: string;
  issue: Issue;
  newId(): string;
  providerRevision: string;
  reservationId: string;
  safety: PersistenceSafetyController;
}): Promise<void> {
  const terminalResultId = input.newId();
  if (!terminalResultId || !input.providerRevision) {
    throw new Error("attempt_closure.identity_invalid");
  }
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const consumption = normalizeConsumption(input.consumption);
    const failureClass =
      consumption.kind === "failure" ? failureClassFor(consumption.errorCode) : null;
    await finishAttempt(input.database, {
      attemptId: input.attemptId,
      costUsd: settlement.costUsd,
      endedAt: input.endedAt,
      failureClass,
      nextClaim: nextClaim(consumption),
      reservationId: input.reservationId,
      settledLedgers: settlement.ledgers.map((ledger) => ({
        actualAmount:
          ledger.unit === "tokens"
            ? settlement.inputTokens + settlement.outputTokens
            : (settlement.costUsd ?? 0),
        id: ledger.id,
      })),
      terminalResult:
        consumption.kind === "terminal_result"
          ? {
              id: terminalResultId,
              kind: "implementation_outcome",
              payload: consumption.result,
              role: "implementation",
            }
          : {
              id: terminalResultId,
              kind: "execution_failure",
              payload: executionFailure(input, consumption, failureClass as FailureClass),
              role: "implementation",
            },
      usage: {
        inputTokens: settlement.inputTokens,
        outputTokens: settlement.outputTokens,
      },
      workRef: { id: input.issue.id, kind: "issue" },
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
}

function normalizeConsumption(
  consumption: AgentConsumptionResult,
):
  | { kind: "terminal_result"; result: ImplementationOutcome }
  | { errorCode: AgentErrorCode; kind: "failure"; providerReason: string } {
  if (consumption.kind === "terminal_result") {
    if (!isImplementationOutcome(consumption.result)) {
      return {
        errorCode: "result_invalid",
        kind: "failure",
        providerReason: "implementation result violated its role contract",
      };
    }
    if (
      consumption.result.status === "completed" &&
      (!("verification" in consumption.result) ||
        consumption.result.verification.result !== "passed" ||
        consumption.result.verification.exit_code !== 0)
    ) {
      return {
        errorCode: "result_invalid",
        kind: "failure",
        providerReason: "completed implementation requires passing agent verification",
      };
    }
    return { kind: "terminal_result", result: consumption.result };
  }
  return consumption;
}

function nextClaim(consumption: ReturnType<typeof normalizeConsumption>):
  | { mode: "Ready"; reason: string }
  | {
      approvalRequestId: null;
      blockerPredicate: null;
      mode: "AwaitingHuman";
      questionId: null;
      reason: string;
    } {
  if (consumption.kind === "failure") {
    const failureClass = AGENT_ERROR_FAILURE_CLASS[consumption.errorCode];
    return failureClass === "budget_exhausted" ||
      failureClass === "auth" ||
      failureClass === "configuration" ||
      failureClass === "policy"
      ? awaitingHuman(failureClass)
      : { mode: "Ready", reason: consumption.errorCode };
  }
  switch (consumption.result.status) {
    case "blocked":
    case "needs_input":
    case "budget_exhausted":
      return awaitingHuman(consumption.result.status);
    case "completed":
      return { mode: "Ready", reason: "independent_verification_required" };
    case "plan_ready":
      return { mode: "Ready", reason: "plan_review_required" };
    case "needs_rework":
      return { mode: "Ready", reason: "implementation_rework" };
    case "no_progress":
      return { mode: "Ready", reason: "no_progress_retry" };
    case "failed":
      return { mode: "Ready", reason: "implementation_failed" };
  }
  throw new Error("attempt_closure.outcome_status_invalid");
}

function awaitingHuman(reason: string) {
  return {
    approvalRequestId: null,
    blockerPredicate: null,
    mode: "AwaitingHuman" as const,
    questionId: null,
    reason,
  };
}

function failureClassFor(errorCode: AgentErrorCode): FailureClass {
  const mapped = AGENT_ERROR_FAILURE_CLASS[errorCode];
  return mapped === "budget_exhausted" ? "agent_process" : mapped;
}

function executionFailure(
  input: Pick<Parameters<typeof closeInitialIssueAttempt>[0], "issue" | "providerRevision">,
  consumption: { errorCode: AgentErrorCode; kind: "failure"; providerReason: string },
  failureClass: FailureClass,
) {
  return {
    evidence: [],
    failure_class: failureClass,
    handoff: {
      acceptance_criteria: input.issue.acceptance_criteria,
      commands: [],
      decisions_fixed: [],
      files_changed: [],
      goal: input.issue.title,
      open_items: input.issue.acceptance_criteria,
      revision: input.providerRevision,
    },
    role: "implementation" as const,
    status:
      AGENT_ERROR_FAILURE_CLASS[consumption.errorCode] === "budget_exhausted"
        ? ("budget_exhausted" as const)
        : ("failed" as const),
    summary: `Agent execution ended with ${consumption.errorCode}.`,
  };
}
