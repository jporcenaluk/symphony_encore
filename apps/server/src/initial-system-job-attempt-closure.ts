import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type ImplementationOutcome,
  isImplementationOutcome,
  type SystemJob,
} from "@symphony/contracts";
import { decideFailureRoute, type FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  finishAttempt,
  loadAttemptSettlementState,
  loadFailureRetryState,
  loadImplementationOutcomeCounts,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";

export async function closeInitialSystemJobAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  database: OpenedDatabase["database"];
  endedAt: string;
  job: Extract<SystemJob, { kind: "repair" }>;
  maxFailureRetries: number;
  maxRetryBackoffMs: number;
  maxReworkCycles: number;
  newId(): string;
  reservationId: string;
  retryJitterSample: number;
  revision: string;
  safety: PersistenceSafetyController;
}): Promise<void> {
  const terminalResultId = input.newId();
  if (!terminalResultId || !input.revision) throw new Error("system_job_closure.identity_invalid");
  try {
    const workRef = { id: input.job.id, kind: "system_job" as const };
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const outcomeCounts = await loadImplementationOutcomeCounts(input.database, workRef);
    const consumption = normalizeConsumption(input.consumption);
    const failureClass =
      consumption.kind === "failure" ? failureClassFor(consumption.errorCode) : null;
    const failureState =
      consumption.kind === "failure" ? await loadFailureRetryState(input.database, workRef) : null;
    const closure = closureRoute(input, consumption, outcomeCounts, failureState);
    const transitionId = closure.targetStage ? input.newId() : null;
    if (closure.targetStage && !transitionId) {
      throw new Error("system_job_closure.transition_identity_invalid");
    }
    await finishAttempt(input.database, {
      attemptId: input.attemptId,
      costUsd: settlement.costUsd,
      endedAt: input.endedAt,
      failureClass,
      nextClaim: closure.nextClaim,
      parkedOriginStage: "running",
      reservationId: input.reservationId,
      ...(closure.retryEntry ? { retryEntry: closure.retryEntry } : {}),
      settledLedgers: settlement.ledgers.map((ledger) => ({
        actualAmount:
          ledger.unit === "tokens"
            ? settlement.inputTokens + settlement.outputTokens
            : (settlement.costUsd ?? 0),
        id: ledger.id,
      })),
      ...(closure.targetStage
        ? {
            systemJobStageTransition: {
              attemptId: input.attemptId,
              confirmedExternalRevision: null,
              enteredAt: input.endedAt,
              expectedFromStage: "running",
              id: transitionId as string,
              reason: closure.reason,
              timestampSource: "observed_estimate" as const,
              toStage: closure.targetStage,
              workRef,
            },
          }
        : {}),
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
      workRef,
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
    Parameters<typeof closeInitialSystemJobAttempt>[0],
    "endedAt" | "maxFailureRetries" | "maxRetryBackoffMs" | "maxReworkCycles" | "retryJitterSample"
  >,
  consumption: ReturnType<typeof normalizeConsumption>,
  outcomeCounts: { noProgress: number; rework: number },
  failureState: Awaited<ReturnType<typeof loadFailureRetryState>> | null,
): {
  nextClaim:
    | { dueAt: string; mode: "RetryQueued"; reason: string }
    | { mode: "Ready"; reason: string }
    | ReturnType<typeof awaitingHuman>;
  reason: string;
  retryEntry: {
    dueAt: string;
    failureClass: string;
    lastError: string;
    maxRetries: number;
    retryNumber: number;
  } | null;
  targetStage: "budget_exhausted" | "human" | "review" | "rework" | null;
} {
  if (consumption.kind === "failure") {
    const mapped = AGENT_ERROR_FAILURE_CLASS[consumption.errorCode];
    if (mapped === "budget_exhausted") {
      return {
        nextClaim: awaitingHuman("budget_exhausted"),
        reason: "execution_failure.budget_exhausted",
        retryEntry: null,
        targetStage: "budget_exhausted",
      };
    }
    if (!failureState) throw new Error("system_job_closure.failure_state_missing");
    const failureClass = failureClassFor(consumption.errorCode);
    const classRetryNumber =
      failureClass === "infrastructure"
        ? failureState.infrastructureFailures + 1
        : failureState.agentProcessFailures + 1;
    const endedAtMs = Date.parse(input.endedAt);
    if (!Number.isFinite(endedAtMs)) throw new Error("system_job_closure.timestamp_invalid");
    const firstInfrastructureMs = failureState.firstInfrastructureFailureAt
      ? Date.parse(failureState.firstInfrastructureFailureAt)
      : endedAtMs;
    if (!Number.isFinite(firstInfrastructureMs)) {
      throw new Error("system_job_closure.persisted_retry_timestamp_invalid");
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
        reason: "execution_failure.retry",
        retryEntry: {
          dueAt,
          failureClass,
          lastError: boundedReason(consumption.providerReason),
          maxRetries: input.maxFailureRetries,
          retryNumber: failureState.retryEntries + 1,
        },
        targetStage: null,
      };
    }
    return {
      nextClaim: awaitingHuman(decision.route === "deny" ? "policy" : "human_review"),
      reason: `execution_failure.${failureClass}`,
      retryEntry: null,
      targetStage: "human",
    };
  }
  const result = consumption.result;
  switch (result.status) {
    case "completed":
      return {
        nextClaim: { mode: "Ready", reason: "independent_verification_required" },
        reason: "implementation.completed",
        retryEntry: null,
        targetStage: "review",
      };
    case "plan_ready":
      return {
        nextClaim: { mode: "Ready", reason: "plan_review_required" },
        reason: "implementation.plan_ready",
        retryEntry: null,
        targetStage: null,
      };
    case "needs_rework":
      return outcomeCounts.rework + 1 >= input.maxReworkCycles
        ? {
            nextClaim: awaitingHuman("human_review"),
            reason: "implementation.rework_limit",
            retryEntry: null,
            targetStage: "human",
          }
        : {
            nextClaim: { mode: "Ready", reason: "implementation_rework" },
            reason: "implementation.needs_rework",
            retryEntry: null,
            targetStage: "rework",
          };
    case "budget_exhausted":
      return {
        nextClaim: awaitingHuman("budget_exhausted"),
        reason: "implementation.budget_exhausted",
        retryEntry: null,
        targetStage: "budget_exhausted",
      };
    case "blocked":
    case "needs_input":
    case "no_progress":
      return {
        nextClaim: awaitingHuman(result.status),
        reason: `implementation.${result.status}`,
        retryEntry: null,
        targetStage: "human",
      };
    case "failed":
      return {
        nextClaim: { mode: "Ready", reason: "implementation_failed" },
        reason: "implementation.failed",
        retryEntry: null,
        targetStage: null,
      };
  }
  throw new Error("system_job_closure.outcome_status_invalid");
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
  input: Pick<Parameters<typeof closeInitialSystemJobAttempt>[0], "job" | "revision">,
  consumption: { errorCode: AgentErrorCode; kind: "failure"; providerReason: string },
  failureClass: FailureClass,
) {
  return {
    evidence: [],
    failure_class: failureClass,
    handoff: {
      acceptance_criteria: input.job.acceptance_criteria,
      commands: [],
      decisions_fixed: [],
      files_changed: [],
      goal: input.job.goal,
      open_items: input.job.acceptance_criteria,
      revision: input.revision,
    },
    role: "implementation" as const,
    status:
      AGENT_ERROR_FAILURE_CLASS[consumption.errorCode] === "budget_exhausted"
        ? ("budget_exhausted" as const)
        : ("failed" as const),
    summary: `Agent execution ended with ${consumption.errorCode}.`,
  };
}

function boundedReason(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/gu, " ")
      .trim()
      .slice(0, 512) || "agent failure"
  );
}
