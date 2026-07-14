import {
  type AdjudicationResult,
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Issue,
  type SystemJob,
  validateAdjudicationResult,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  finishAdjudicationAttempt,
  finishAttempt,
  loadAttemptSettlementState,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import type { IntegrativeReviewContext } from "./integrative-review-attempt-planner.js";

export async function closeAdjudicationAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  context: IntegrativeReviewContext;
  database: OpenedDatabase["database"];
  endedAt: string;
  issue: Issue | SystemJob;
  newId(): string;
  reservationId: string;
  safety: PersistenceSafetyController;
}): Promise<AgentConsumptionResult> {
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const consumption = normalize(input.consumption, input.context.targetSha);
    const terminalResultId = requiredId(input.newId());
    const settledLedgers = settlement.ledgers.map((ledger) => ({
      actualAmount:
        ledger.unit === "tokens"
          ? settlement.inputTokens + settlement.outputTokens
          : (settlement.costUsd ?? 0),
      id: ledger.id,
    }));
    if (consumption.kind === "terminal_result") {
      await finishAdjudicationAttempt(input.database, {
        attemptId: input.attemptId,
        costUsd: settlement.costUsd,
        endedAt: input.endedAt,
        questionId:
          consumption.result.decision === "needs_human" ? requiredId(input.newId()) : null,
        reservationId: input.reservationId,
        result: consumption.result,
        reviewRecordId: requiredId(input.newId()),
        settledLedgers,
        terminalResultId,
        usage: { inputTokens: settlement.inputTokens, outputTokens: settlement.outputTokens },
        workRef: reviewWorkRef(input.issue),
      });
      return consumption;
    }
    const failureClass = failureClassFor(consumption.errorCode);
    await finishAttempt(input.database, {
      attemptId: input.attemptId,
      costUsd: settlement.costUsd,
      endedAt: input.endedAt,
      failureClass,
      nextClaim: nextFailureClaim(consumption.errorCode),
      reservationId: input.reservationId,
      settledLedgers,
      terminalResult: {
        id: terminalResultId,
        kind: "execution_failure",
        payload: {
          evidence: [],
          failure_class: failureClass,
          handoff: {
            acceptance_criteria: input.issue.acceptance_criteria,
            commands: [],
            decisions_fixed: [],
            files_changed: [...input.context.changedFiles],
            goal: "kind" in input.issue ? input.issue.goal : input.issue.title,
            open_items: input.issue.acceptance_criteria,
            revision: input.context.targetSha,
          },
          role: "adjudication",
          status:
            AGENT_ERROR_FAILURE_CLASS[consumption.errorCode] === "budget_exhausted"
              ? "budget_exhausted"
              : "failed",
          summary: `Adjudication ended with ${consumption.errorCode}: ${consumption.providerReason}`,
        },
        role: "adjudication",
      },
      usage: { inputTokens: settlement.inputTokens, outputTokens: settlement.outputTokens },
      workRef: reviewWorkRef(input.issue),
    });
    return consumption;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
}

function reviewWorkRef(work: Issue | SystemJob): {
  id: string;
  kind: "issue" | "system_job";
} {
  return "kind" in work ? { id: work.id, kind: "system_job" } : { id: work.id, kind: "issue" };
}

function normalize(
  consumption: AgentConsumptionResult,
  targetSha: string,
):
  | { kind: "terminal_result"; result: AdjudicationResult }
  | { errorCode: AgentErrorCode; kind: "failure"; providerReason: string } {
  if (consumption.kind === "failure") return consumption;
  const validation = validateAdjudicationResult(consumption.result);
  if (validation.ok && (consumption.result as AdjudicationResult).target_sha === targetSha) {
    return { kind: "terminal_result", result: consumption.result as AdjudicationResult };
  }
  return {
    errorCode: "result_invalid",
    kind: "failure",
    providerReason: validation.ok ? "Adjudication targeted the wrong SHA" : validation.reason,
  };
}

function nextFailureClaim(errorCode: AgentErrorCode):
  | { mode: "Ready"; reason: string }
  | {
      approvalRequestId: null;
      blockerPredicate: null;
      mode: "AwaitingHuman";
      questionId: null;
      reason: string;
    } {
  const failureClass = AGENT_ERROR_FAILURE_CLASS[errorCode];
  return failureClass === "budget_exhausted" ||
    failureClass === "auth" ||
    failureClass === "configuration" ||
    failureClass === "policy"
    ? {
        approvalRequestId: null,
        blockerPredicate: null,
        mode: "AwaitingHuman",
        questionId: null,
        reason: failureClass,
      }
    : { mode: "Ready", reason: errorCode };
}

function failureClassFor(errorCode: AgentErrorCode): FailureClass {
  const mapped = AGENT_ERROR_FAILURE_CLASS[errorCode];
  return mapped === "budget_exhausted" ? "agent_process" : mapped;
}

function requiredId(id: string): string {
  if (!id) throw new Error("adjudication.identity_invalid");
  return id;
}
