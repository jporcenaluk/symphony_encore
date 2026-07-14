import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type ImplementationOutcome,
  type Issue,
  isImplementationOutcome,
} from "@symphony/contracts";
import { decideFailureRoute, type FailureClass } from "@symphony/domain";
import {
  type PersistenceSafetyController,
  routeImplementationOutcome,
} from "@symphony/orchestration";
import {
  finishAttempt,
  loadAttemptSettlementState,
  loadFailureRetryState,
  loadImplementationOutcomeCounts,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";

export async function closeInitialIssueAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  database: OpenedDatabase["database"];
  endedAt: string;
  issue: Issue;
  maxFailureRetries: number;
  maxRetryBackoffMs: number;
  maxReworkCycles: number;
  newId(): string;
  providerRevision: string;
  reservationId: string;
  retryJitterSample: number;
  safety: PersistenceSafetyController;
}): Promise<void> {
  const terminalResultId = input.newId();
  if (
    !terminalResultId ||
    !input.providerRevision ||
    !Number.isSafeInteger(input.maxFailureRetries) ||
    input.maxFailureRetries < 0 ||
    !Number.isSafeInteger(input.maxRetryBackoffMs) ||
    input.maxRetryBackoffMs < 0 ||
    !Number.isSafeInteger(input.maxReworkCycles) ||
    input.maxReworkCycles < 0 ||
    input.retryJitterSample < 0 ||
    input.retryJitterSample > 1
  ) {
    throw new Error("attempt_closure.identity_invalid");
  }
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const outcomeCounts = await loadImplementationOutcomeCounts(input.database, {
      id: input.issue.id,
      kind: "issue",
    });
    const consumption = normalizeConsumption(input.consumption);
    const failureClass =
      consumption.kind === "failure" ? failureClassFor(consumption.errorCode) : null;
    const failureState =
      consumption.kind === "failure"
        ? await loadFailureRetryState(input.database, {
            id: input.issue.id,
            kind: "issue",
          })
        : null;
    const closure = closureRoute(input, consumption, outcomeCounts, failureState);
    await finishAttempt(input.database, {
      attemptId: input.attemptId,
      costUsd: settlement.costUsd,
      endedAt: input.endedAt,
      failureClass,
      nextClaim: closure.nextClaim,
      parkedOriginStage: "In Progress",
      reservationId: input.reservationId,
      ...(closure.retryEntry ? { retryEntry: closure.retryEntry } : {}),
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

function closureRoute(
  input: Pick<
    Parameters<typeof closeInitialIssueAttempt>[0],
    "endedAt" | "maxFailureRetries" | "maxRetryBackoffMs" | "maxReworkCycles" | "retryJitterSample"
  >,
  consumption: ReturnType<typeof normalizeConsumption>,
  outcomeCounts: { noProgress: number; rework: number },
  failureState: Awaited<ReturnType<typeof loadFailureRetryState>> | null,
): {
  nextClaim:
    | { dueAt: string; mode: "RetryQueued"; reason: string }
    | { mode: "Ready"; reason: string }
    | {
        approvalRequestId: null;
        blockerPredicate: null;
        mode: "AwaitingHuman";
        questionId: null;
        reason: string;
      };
  retryEntry: {
    dueAt: string;
    failureClass: string;
    lastError: string;
    maxRetries: number;
    retryNumber: number;
  } | null;
} {
  if (consumption.kind === "failure") {
    const mapped = AGENT_ERROR_FAILURE_CLASS[consumption.errorCode];
    if (mapped === "budget_exhausted") {
      return { nextClaim: awaitingHuman("budget_exhausted"), retryEntry: null };
    }
    if (!failureState) throw new Error("attempt_closure.failure_state_missing");
    const failureClass = failureClassFor(consumption.errorCode);
    const classRetryNumber =
      failureClass === "infrastructure"
        ? failureState.infrastructureFailures + 1
        : failureState.agentProcessFailures + 1;
    const endedAtMs = Date.parse(input.endedAt);
    if (!Number.isFinite(endedAtMs)) throw new Error("attempt_closure.timestamp_invalid");
    const firstInfrastructureMs = failureState.firstInfrastructureFailureAt
      ? Date.parse(failureState.firstInfrastructureFailureAt)
      : endedAtMs;
    if (!Number.isFinite(firstInfrastructureMs)) {
      throw new Error("attempt_closure.persisted_retry_timestamp_invalid");
    }
    const decision = decideFailureRoute({
      baseBackoffMs: 10_000,
      elapsedInfrastructureFailureMs: Math.max(0, endedAtMs - firstInfrastructureMs),
      failureClass,
      jitterSample: input.retryJitterSample,
      maxBackoffMs: input.maxRetryBackoffMs,
      maxFailureRetries: input.maxFailureRetries,
      retryAfterMs: null,
      retryNumber: classRetryNumber,
    });
    if (decision.route === "retry") {
      const dueAt = new Date(endedAtMs + decision.delayMs).toISOString();
      return {
        nextClaim: { dueAt, mode: "RetryQueued", reason: consumption.errorCode },
        retryEntry: {
          dueAt,
          failureClass,
          lastError: boundedReason(consumption.providerReason),
          maxRetries: input.maxFailureRetries,
          retryNumber: failureState.retryEntries + 1,
        },
      };
    }
    if (decision.route === "human") {
      return { nextClaim: awaitingHuman("human_review"), retryEntry: null };
    }
    if (decision.route === "pause_scope") {
      return { nextClaim: awaitingHuman(failureClass), retryEntry: null };
    }
    if (decision.route === "deny") {
      return { nextClaim: awaitingHuman("policy"), retryEntry: null };
    }
    return { nextClaim: awaitingHuman("needs_input"), retryEntry: null };
  }
  const nextClaim = nextClaimForOutcome(consumption.result, input.maxReworkCycles, outcomeCounts);
  return { nextClaim, retryEntry: null };
}

function nextClaimForOutcome(
  result: ImplementationOutcome,
  maxReworkCycles: number,
  outcomeCounts: { noProgress: number; rework: number },
):
  | { mode: "Ready"; reason: string }
  | {
      approvalRequestId: null;
      blockerPredicate: null;
      mode: "AwaitingHuman";
      questionId: null;
      reason: string;
    } {
  switch (result.status) {
    case "blocked":
    case "needs_input":
    case "budget_exhausted":
      return awaitingHuman(result.status);
    case "completed":
      return { mode: "Ready", reason: "independent_verification_required" };
    case "plan_ready":
      return { mode: "Ready", reason: "plan_review_required" };
    case "needs_rework": {
      const route = routeImplementationOutcome({
        agentVerificationPassed: null,
        maxReworkCycles,
        noProgressCount: outcomeCounts.noProgress,
        reworkCycle: outcomeCounts.rework + 1,
        status: "needs_rework",
        workKind: "issue",
      });
      return route.route === "issue_lane" && route.claimMode === "AwaitingHuman"
        ? awaitingHuman("human_review")
        : { mode: "Ready", reason: "implementation_rework" };
    }
    case "no_progress": {
      const route = routeImplementationOutcome({
        agentVerificationPassed: null,
        maxReworkCycles,
        noProgressCount: outcomeCounts.noProgress,
        reworkCycle: outcomeCounts.rework,
        status: "no_progress",
        workKind: "issue",
      });
      return route.route === "retry_fresh"
        ? { mode: "Ready", reason: "no_progress_retry" }
        : awaitingHuman("no_progress");
    }
    case "failed":
      return { mode: "Ready", reason: "implementation_failed" };
  }
  throw new Error("attempt_closure.outcome_status_invalid");
}

function boundedReason(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/gu, " ")
      .trim()
      .slice(0, 512) || "agent failure"
  );
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
