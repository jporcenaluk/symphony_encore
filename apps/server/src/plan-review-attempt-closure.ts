import { Value } from "@sinclair/typebox/value";
import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Issue,
  type Plan,
  type PlanReviewResult,
  PlanReviewResultSchema,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  finishAttempt,
  finishPlanReviewAttempt,
  loadAttemptSettlementState,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";

export async function closePlanReviewAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  database: OpenedDatabase["database"];
  endedAt: string;
  issue: Issue;
  maxPlanRevisions: number;
  newId(): string;
  plan: Plan;
  repositoryRevision: string;
  reservationId: string;
  safety: PersistenceSafetyController;
}): Promise<AgentConsumptionResult> {
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const consumption = normalizeConsumption(input.consumption, input.plan.revision);
    const terminalResultId = requiredId(input.newId(), "plan_review.result_identity_invalid");
    const settledLedgers = settlement.ledgers.map((ledger) => ({
      actualAmount:
        ledger.unit === "tokens"
          ? settlement.inputTokens + settlement.outputTokens
          : (settlement.costUsd ?? 0),
      id: ledger.id,
    }));
    if (consumption.kind === "terminal_result") {
      const questionId =
        consumption.result.decision === "needs_input"
          ? requiredId(input.newId(), "plan_review.question_identity_invalid")
          : null;
      await finishPlanReviewAttempt(input.database, {
        attemptId: input.attemptId,
        costUsd: settlement.costUsd,
        endedAt: input.endedAt,
        maxPlanRevisions: input.maxPlanRevisions,
        planId: input.plan.id,
        questionId,
        reservationId: input.reservationId,
        result: consumption.result,
        settledLedgers,
        terminalResultId,
        usage: {
          inputTokens: settlement.inputTokens,
          outputTokens: settlement.outputTokens,
        },
        workRef: { id: input.issue.id, kind: "issue" },
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
        payload: executionFailure(input, consumption, failureClass),
        role: "plan_review",
      },
      usage: {
        inputTokens: settlement.inputTokens,
        outputTokens: settlement.outputTokens,
      },
      workRef: { id: input.issue.id, kind: "issue" },
    });
    return consumption;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
}

function normalizeConsumption(
  consumption: AgentConsumptionResult,
  planRevision: number,
):
  | { kind: "terminal_result"; result: PlanReviewResult }
  | { errorCode: AgentErrorCode; kind: "failure"; providerReason: string } {
  if (consumption.kind === "failure") return consumption;
  if (
    Value.Check(PlanReviewResultSchema, consumption.result) &&
    consumption.result.plan_revision === planRevision
  ) {
    return { kind: "terminal_result", result: consumption.result };
  }
  return {
    errorCode: "result_invalid",
    kind: "failure",
    providerReason: "Plan-review result targeted the wrong Plan revision",
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

function executionFailure(
  input: Pick<
    Parameters<typeof closePlanReviewAttempt>[0],
    "issue" | "plan" | "repositoryRevision"
  >,
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
      open_items: input.plan.acceptance_criteria.map((criterion) => criterion.criterion_text),
      revision: input.repositoryRevision,
    },
    role: "plan_review" as const,
    status:
      AGENT_ERROR_FAILURE_CLASS[consumption.errorCode] === "budget_exhausted"
        ? ("budget_exhausted" as const)
        : ("failed" as const),
    summary: `Plan reviewer ended with ${consumption.errorCode}: ${consumption.providerReason}`,
  };
}

function requiredId(id: string, message: string): string {
  if (!id) throw new Error(message);
  return id;
}
