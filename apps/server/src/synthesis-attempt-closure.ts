import { Value } from "@sinclair/typebox/value";
import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Rule,
  type SynthesisResult,
  SynthesisResultSchema,
  type SystemJob,
} from "@symphony/contracts";
import { decideFailureRoute, validateRuleChanges } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  type FailureRetryState,
  finishAttempt,
  finishSynthesisAttempt,
  loadAttemptSettlementState,
  loadFailureRetryState,
  loadSynthesisValidationState,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { AgentConsumptionResult } from "./agent-event-consumer.js";

export interface SynthesisValidationInput {
  currentRules: readonly Rule[];
  knownLessonIds: readonly string[];
  maxPromptTokens: number;
  maxRules: number;
  repositoryRevision: string;
}

export function validateSynthesisResult(
  candidate: unknown,
  input: SynthesisValidationInput,
): SynthesisResult {
  if (!Value.Check(SynthesisResultSchema, candidate)) {
    throw new Error("synthesis.result_invalid");
  }
  const result = candidate as SynthesisResult;
  const known = new Set(input.knownLessonIds);
  const cited = new Set(result.cited_lesson_ids);
  for (const lessonId of cited) {
    if (!known.has(lessonId)) throw new Error(`synthesis.lesson_unknown:${lessonId}`);
  }
  for (const change of result.rule_changes) {
    for (const lessonId of change.lesson_ids) {
      if (!known.has(lessonId)) throw new Error(`synthesis.lesson_unknown:${lessonId}`);
      if (!cited.has(lessonId)) throw new Error(`synthesis.lesson_citation_missing:${lessonId}`);
    }
  }
  if (
    result.decision === "propose_changes" &&
    (result.repository_revision !== input.repositoryRevision ||
      result.handoff.revision !== input.repositoryRevision)
  ) {
    throw new Error("synthesis.repository_revision_mismatch");
  }
  const validation = validateRuleChanges({
    changes: result.rule_changes.map((change) => ({
      action: change.action,
      lessonIds: change.lesson_ids,
      rationale: change.rationale,
      ruleId: change.rule_id,
      text: change.text,
    })),
    currentRules: input.currentRules.map((rule) => ({
      id: rule.id,
      lessonIds: rule.lesson_ids,
      text: rule.text,
    })),
    maxPromptTokens: input.maxPromptTokens,
    maxRules: input.maxRules,
    proposedPromptTokens: estimatePromptTokens(result, input.currentRules),
  });
  if (!validation.ok) throw new Error(validation.reason);
  return result;
}

export async function closeSynthesisAttempt(input: {
  attemptId: string;
  consumption: AgentConsumptionResult;
  database: OpenedDatabase["database"];
  endedAt: string;
  job: Extract<SystemJob, { kind: "synthesis" }>;
  maxFailureRetries: number;
  maxPromptTokens: number;
  maxRetryBackoffMs: number;
  maxRules: number;
  newId(): string;
  repositoryRevision: string;
  reservationId: string;
  retryJitterSample: number;
  safety: PersistenceSafetyController;
}): Promise<AgentConsumptionResult> {
  if (
    !Number.isSafeInteger(input.maxFailureRetries) ||
    input.maxFailureRetries < 0 ||
    !Number.isSafeInteger(input.maxRetryBackoffMs) ||
    input.maxRetryBackoffMs < 0 ||
    input.retryJitterSample < 0 ||
    input.retryJitterSample > 1
  ) {
    throw new Error("synthesis.closure_policy_invalid");
  }
  try {
    const settlement = await loadAttemptSettlementState(input.database, {
      attemptId: input.attemptId,
      reservationId: input.reservationId,
    });
    const terminalResultId = requiredId(input.newId());
    const stageTransitionId = requiredId(input.newId());
    const settledLedgers = settlement.ledgers.map((ledger) => ({
      actualAmount:
        ledger.unit === "tokens"
          ? settlement.inputTokens + settlement.outputTokens
          : (settlement.costUsd ?? 0),
      id: ledger.id,
    }));
    if (input.consumption.kind === "terminal_result") {
      const validation = await loadSynthesisValidationState(input.database);
      const result = validateSynthesisResult(input.consumption.result, {
        currentRules: validation.rules,
        knownLessonIds: validation.knownLessonIds,
        maxPromptTokens: input.maxPromptTokens,
        maxRules: input.maxRules,
        repositoryRevision: input.repositoryRevision,
      });
      await finishSynthesisAttempt(input.database, {
        attemptId: input.attemptId,
        costUsd: settlement.costUsd,
        endedAt: input.endedAt,
        questionId: result.decision === "needs_input" ? requiredId(input.newId()) : null,
        reservationId: input.reservationId,
        result,
        settledLedgers,
        stageTransitionId,
        terminalResultId,
        usage: { inputTokens: settlement.inputTokens, outputTokens: settlement.outputTokens },
        workRef: { id: input.job.id, kind: "system_job" },
      });
      return { kind: "terminal_result", result };
    }
    const failure = failureClass(input.consumption.errorCode);
    const failureState = await loadFailureRetryState(input.database, {
      id: input.job.id,
      kind: "system_job",
      role: "synthesis",
    });
    const closure = planSynthesisFailureClosure(input, input.consumption, failureState);
    await finishAttempt(input.database, {
      attemptId: input.attemptId,
      costUsd: settlement.costUsd,
      endedAt: input.endedAt,
      failureClass: failure,
      nextClaim: closure.nextClaim,
      parkedOriginStage: "running",
      reservationId: input.reservationId,
      ...(closure.retryEntry ? { retryEntry: closure.retryEntry } : {}),
      settledLedgers,
      systemJobStageTransition: {
        attemptId: input.attemptId,
        confirmedExternalRevision: null,
        enteredAt: input.endedAt,
        expectedFromStage: "running",
        id: stageTransitionId,
        reason: `synthesis.${input.consumption.errorCode}`,
        timestampSource: "observed_estimate",
        toStage: closure.targetStage,
        workRef: { id: input.job.id, kind: "system_job" },
      },
      terminalResult: {
        id: terminalResultId,
        kind: "execution_failure",
        payload: {
          evidence: [],
          failure_class: failure,
          handoff: {
            acceptance_criteria: input.job.acceptance_criteria,
            commands: [],
            decisions_fixed: [],
            files_changed: [],
            goal: input.job.goal,
            open_items: input.job.acceptance_criteria,
            revision: input.repositoryRevision,
          },
          role: "synthesis",
          status:
            AGENT_ERROR_FAILURE_CLASS[input.consumption.errorCode] === "budget_exhausted"
              ? "budget_exhausted"
              : "failed",
          summary: `Synthesis ended with ${input.consumption.errorCode}: ${input.consumption.providerReason}`,
        },
        role: "synthesis",
      },
      usage: { inputTokens: settlement.inputTokens, outputTokens: settlement.outputTokens },
      workRef: { id: input.job.id, kind: "system_job" },
    });
    return input.consumption;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
}

export function planSynthesisFailureClosure(
  input: {
    endedAt: string;
    maxFailureRetries: number;
    maxRetryBackoffMs: number;
    retryJitterSample: number;
  },
  consumption: Extract<AgentConsumptionResult, { kind: "failure" }>,
  failureState: FailureRetryState,
): {
  nextClaim:
    | { dueAt: string; mode: "RetryQueued"; reason: "synthesis_retry_required" }
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
  targetStage: "human" | "rework";
} {
  const mapped = AGENT_ERROR_FAILURE_CLASS[consumption.errorCode];
  const failure = failureClass(consumption.errorCode);
  const failureNumber =
    failure === "infrastructure"
      ? failureState.infrastructureFailures + 1
      : failureState.agentProcessFailures + 1;
  const endedAtMs = Date.parse(input.endedAt);
  if (!Number.isFinite(endedAtMs)) throw new Error("synthesis.timestamp_invalid");
  const firstInfrastructureMs = failureState.firstInfrastructureFailureAt
    ? Date.parse(failureState.firstInfrastructureFailureAt)
    : endedAtMs;
  if (!Number.isFinite(firstInfrastructureMs)) {
    throw new Error("synthesis.persisted_retry_timestamp_invalid");
  }
  const decision = decideFailureRoute({
    baseBackoffMs: 10_000,
    elapsedInfrastructureFailureMs: Math.max(0, endedAtMs - firstInfrastructureMs),
    failureClass: failure,
    jitterSample: input.retryJitterSample,
    maxBackoffMs: input.maxRetryBackoffMs,
    maxFailureRetries: input.maxFailureRetries,
    retryAfterMs: null,
    retryNumber: failureNumber,
  });
  if (decision.route === "retry" && mapped !== "budget_exhausted") {
    const dueAt = new Date(endedAtMs + decision.delayMs).toISOString();
    return {
      nextClaim: { dueAt, mode: "RetryQueued", reason: "synthesis_retry_required" },
      retryEntry: {
        dueAt,
        failureClass: failure,
        lastError: consumption.providerReason.slice(0, 256),
        maxRetries: input.maxFailureRetries,
        retryNumber: failureState.retryEntries + 1,
      },
      targetStage: "rework",
    };
  }
  return {
    nextClaim: {
      approvalRequestId: null,
      blockerPredicate: null,
      mode: "AwaitingHuman",
      questionId: null,
      reason: mapped,
    },
    retryEntry: null,
    targetStage: "human",
  };
}

function estimatePromptTokens(result: SynthesisResult, currentRules: readonly Rule[]): number {
  const rules = new Map(currentRules.map((rule) => [rule.id, rule.text]));
  for (const change of result.rule_changes) {
    if (change.action === "remove") rules.delete(change.rule_id);
    else rules.set(change.rule_id, change.text);
  }
  return Math.ceil([...rules.values()].join("\n").length / 4);
}

function failureClass(errorCode: AgentErrorCode) {
  const mapped = AGENT_ERROR_FAILURE_CLASS[errorCode];
  return mapped === "budget_exhausted" ? ("agent_process" as const) : mapped;
}

function requiredId(id: string): string {
  if (!id) throw new Error("synthesis.identity_invalid");
  return id;
}
