import { Value } from "@sinclair/typebox/value";
import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Issue,
  type ReviewResult,
  ReviewResultSchema,
  type SystemJob,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  finishAttempt,
  finishReviewAttempt,
  loadAttemptSettlementState,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import type { IntegrativeReviewContext } from "./integrative-review-attempt-planner.js";

interface CloseReviewAttemptInput {
  attemptId: string;
  consumption: AgentConsumptionResult;
  context: IntegrativeReviewContext;
  database: OpenedDatabase["database"];
  endedAt: string;
  issue: Issue | SystemJob;
  newId(): string;
  reservationId: string;
  safety: PersistenceSafetyController;
}

export async function closeIntegrativeReviewAttempt(
  input: CloseReviewAttemptInput,
): Promise<AgentConsumptionResult> {
  return closeReviewAttempt(input, "integrative_review");
}

export async function closeSpecialistReviewAttempt(
  input: CloseReviewAttemptInput,
): Promise<AgentConsumptionResult> {
  return closeReviewAttempt(input, "specialist_review");
}

async function closeReviewAttempt(
  input: CloseReviewAttemptInput,
  reviewerRole: "integrative_review" | "specialist_review",
): Promise<AgentConsumptionResult> {
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const consumption = normalizeConsumption(input.consumption, input.context.targetSha);
    const terminalResultId = requiredId(input.newId());
    const settledLedgers = settlement.ledgers.map((ledger) => ({
      actualAmount:
        ledger.unit === "tokens"
          ? settlement.inputTokens + settlement.outputTokens
          : (settlement.costUsd ?? 0),
      id: ledger.id,
    }));
    if (consumption.kind === "terminal_result") {
      await finishReviewAttempt(input.database, {
        attemptId: input.attemptId,
        costUsd: settlement.costUsd,
        endedAt: input.endedAt,
        patchIdentity: input.context.patchIdentity,
        reservationId: input.reservationId,
        result: consumption.result,
        reviewRecordId: requiredId(input.newId()),
        reviewerRole,
        settledLedgers,
        targetBaseSha: input.context.baseSha,
        targetSha: input.context.targetSha,
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
          role: reviewerRole,
          status:
            AGENT_ERROR_FAILURE_CLASS[consumption.errorCode] === "budget_exhausted"
              ? "budget_exhausted"
              : "failed",
          summary: `${reviewerRole} ended with ${consumption.errorCode}: ${consumption.providerReason}`,
        },
        role: reviewerRole,
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

function normalizeConsumption(
  consumption: AgentConsumptionResult,
  targetSha: string,
):
  | { kind: "terminal_result"; result: ReviewResult }
  | { errorCode: AgentErrorCode; kind: "failure"; providerReason: string } {
  if (consumption.kind === "failure") return consumption;
  if (
    Value.Check(ReviewResultSchema, consumption.result) &&
    consumption.result.target_sha === targetSha
  ) {
    return { kind: "terminal_result", result: consumption.result };
  }
  return {
    errorCode: "result_invalid",
    kind: "failure",
    providerReason: "Review result targeted the wrong immutable SHA",
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
  if (!id) throw new Error("review.identity_invalid");
  return id;
}
