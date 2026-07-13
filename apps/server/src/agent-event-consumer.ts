import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentAdapterManifest, AgentErrorCode, AgentEvent } from "@symphony/contracts";
import { validateAgentToolArguments } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  loadAttemptPlanGateState,
  type OpenedDatabase,
  recordAttemptUsageSample,
  recordLiveSessionEvent,
  recordSubmittedPlan,
} from "@symphony/persistence";

import type { BoundAgentSession } from "./agent-session-binding.js";

export type AgentConsumptionResult =
  | { kind: "terminal_result"; result: unknown }
  | { errorCode: AgentErrorCode; kind: "failure"; providerReason: string };

export async function consumeAgentSession(input: {
  attemptTokenCap: number;
  bound: BoundAgentSession;
  database: OpenedDatabase["database"];
  manifest: AgentAdapterManifest;
  newId(): string;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  usdCap: number;
}): Promise<AgentConsumptionResult> {
  validateCaps(input.attemptTokenCap, input.usdCap);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let terminalResult: unknown;
  let terminalResultReported = false;

  for await (const event of input.bound.events) {
    if (
      event.attempt_id !== input.bound.started.attempt_id ||
      event.session_id !== input.bound.started.session_id
    ) {
      await input.bound.session.cancel("protocol_incompatible");
      return failure("protocol_incompatible", "agent event identity mismatch");
    }
    if (isTokenUsage(event)) {
      const costUsd = absoluteCostUsd(input.manifest, input.bound.started.model, event);
      await durable(input, () =>
        recordAttemptUsageSample(input.database, {
          attemptId: event.attempt_id,
          billableCategories: event.billable_categories,
          costUsd,
          id: input.newId(),
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          serviceRunId: input.serviceRunId,
          timestamp: event.timestamp,
          totalTokens: event.total_tokens,
          turnCount: 1,
          turnId: input.bound.started.turn_id,
        }),
      );
      inputTokens = event.input_tokens;
      outputTokens = event.output_tokens;
      totalTokens = event.total_tokens;
      if (totalTokens >= input.attemptTokenCap) {
        await input.bound.session.cancel("token_cap_exceeded");
        await input.bound.session.waitForExit();
        return failure("token_cap_exceeded", "attempt token cap reached");
      }
      if (costUsd !== null && costUsd >= input.usdCap) {
        await input.bound.session.cancel("usd_cap_exceeded");
        await input.bound.session.waitForExit();
        return failure("usd_cap_exceeded", "attempt USD cap reached");
      }
      continue;
    }

    await durable(input, () =>
      recordLiveSessionEvent(input.database, {
        attemptId: event.attempt_id,
        event: event.event,
        eventAt: event.timestamp,
        inputTokens,
        outputTokens,
        totalTokens,
        turnCount: 1,
        turnId: input.bound.started.turn_id,
      }),
    );
    if (event.event === "action_started" && input.bound.preflight.submitPlanSchema !== null) {
      const gate = await durable(input, () =>
        loadAttemptPlanGateState(input.database, input.bound.started.attempt_id),
      );
      if (!gate.validatedPlan && !gate.approvedPlan) {
        return rejectBound(input.bound, "implementation action started before a validated Plan");
      }
      if (gate.changeClass === "high_risk" && gate.validatedPlan) {
        return rejectBound(input.bound, "high-risk implementation continued after Plan validation");
      }
    }
    if (isPlanReported(event)) {
      const schema = input.bound.preflight.submitPlanSchema;
      if (schema === null || !validateAgentToolArguments(schema, event.plan)) {
        await input.bound.session.cancel("result_invalid");
        await input.bound.session.waitForExit();
        return failure("result_invalid", "submitted plan violated the negotiated schema");
      }
      const invalid = await storePlan(input, event.plan);
      if (invalid) return invalid;
      continue;
    }
    if (isTerminalResult(event)) {
      if (!terminalResultIsValid(input.bound.preflight.terminalResultSchema, event.result)) {
        await input.bound.session.cancel("result_invalid");
        await input.bound.session.waitForExit();
        return failure("result_invalid", "terminal result violated the negotiated role schema");
      }
      const gateFailure = await implementationTerminalGateFailure(input, event.result);
      if (gateFailure) return rejectBound(input.bound, gateFailure);
      terminalResult = event.result;
      terminalResultReported = true;
      continue;
    }
    if (event.event === "turn_completed") {
      await input.bound.session.waitForExit();
      return terminalResultReported
        ? { kind: "terminal_result", result: terminalResult }
        : failure("result_missing", "turn completed without a terminal result");
    }
    if (event.event === "turn_failed") {
      await input.bound.session.waitForExit();
      return failure("turn_failed", providerReason(event, "turn failed"));
    }
    if (event.event === "turn_cancelled") {
      await input.bound.session.waitForExit();
      return failure("turn_cancelled", providerReason(event, "turn cancelled"));
    }
    if (event.event === "turn_input_required") {
      await input.bound.session.cancel("turn_input_required");
      await input.bound.session.waitForExit();
      return failure("turn_input_required", providerReason(event, "turn input required"));
    }
    if (event.event === "malformed" || event.event === "startup_failed") {
      await input.bound.session.cancel("protocol_incompatible");
      await input.bound.session.waitForExit();
      return failure("protocol_incompatible", `unexpected agent event: ${event.event}`);
    }
  }
  await input.bound.session.waitForExit();
  return failure("process_exit", "agent event stream ended before turn completion");
}

async function implementationTerminalGateFailure(
  input: Parameters<typeof consumeAgentSession>[0],
  result: unknown,
): Promise<string | null> {
  if (input.bound.preflight.submitPlanSchema === null || !isRecord(result)) return null;
  const status = result.status;
  if (typeof status !== "string") return null;
  const gate = await durable(input, () =>
    loadAttemptPlanGateState(input.database, input.bound.started.attempt_id),
  );
  if (gate.changeClass === "high_risk") {
    if (gate.validatedPlan) {
      return status === "plan_ready" ? null : "high-risk implementation must stop with plan_ready";
    }
    if (gate.approvedPlan) {
      return status === "plan_ready"
        ? "approved high-risk Plan must proceed to implementation"
        : null;
    }
    return "high-risk implementation requires a validated or approved Plan";
  }
  if (status === "plan_ready") return "plan_ready requires a high-risk authoritative Plan";
  if (
    (status === "completed" || status === "needs_rework") &&
    !gate.validatedPlan &&
    !gate.approvedPlan
  ) {
    return "implementation outcome requires a validated Plan";
  }
  return null;
}

async function rejectBound(
  bound: BoundAgentSession,
  providerReason: string,
): Promise<AgentConsumptionResult> {
  await bound.session.cancel("result_invalid");
  await bound.session.waitForExit();
  return failure("result_invalid", providerReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanReported(
  event: AgentEvent,
): event is AgentEvent & { event: "plan_reported"; plan: unknown } {
  return event.event === "plan_reported" && "plan" in event;
}

async function storePlan(
  input: Parameters<typeof consumeAgentSession>[0],
  plan: unknown,
): Promise<AgentConsumptionResult | null> {
  try {
    await recordSubmittedPlan(input.database, {
      attemptId: input.bound.started.attempt_id,
      plan,
    });
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("plan.")) {
      await input.bound.session.cancel("result_invalid");
      await input.bound.session.waitForExit();
      return failure("result_invalid", error.message);
    }
    const persistenceError = error instanceof Error ? error : new Error(String(error));
    try {
      await input.safety.recordFailure(persistenceError);
    } finally {
      try {
        await input.bound.session.cancel("persistence_failure");
      } catch {
        // The safety controller's process-group stop remains authoritative.
      }
    }
    throw persistenceError;
  }
}

function terminalResultIsValid(
  schema: Readonly<Record<string, unknown>>,
  result: unknown,
): boolean {
  try {
    return Value.Check(schema as TSchema, result);
  } catch {
    return false;
  }
}

function isTokenUsage(event: AgentEvent): event is AgentEvent & {
  billable_categories: Record<string, number>;
  cost_usd: number | null;
  event: "token_usage";
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  return (
    event.event === "token_usage" &&
    "billable_categories" in event &&
    "cost_usd" in event &&
    "input_tokens" in event &&
    "output_tokens" in event &&
    "total_tokens" in event
  );
}

function isTerminalResult(
  event: AgentEvent,
): event is AgentEvent & { event: "terminal_result_reported"; result: unknown } {
  return event.event === "terminal_result_reported" && "result" in event;
}

function absoluteCostUsd(
  manifest: AgentAdapterManifest,
  model: string,
  event: AgentEvent & {
    billable_categories: Record<string, number>;
    cost_usd: number | null;
    input_tokens: number;
    output_tokens: number;
  },
): number | null {
  if (event.cost_usd !== null) return event.cost_usd;
  if (manifest.price_table === null) return null;
  const price = manifest.price_table.models[model];
  if (!price) throw new Error(`agent.price_missing:${model}`);
  const cachedInput = event.billable_categories.cached_input_tokens ?? 0;
  if (cachedInput > event.input_tokens) throw new Error("agent.cached_input_invalid");
  const uncachedInput = event.input_tokens - cachedInput;
  return (
    (uncachedInput * price.input_per_million_usd +
      cachedInput * (price.cached_input_per_million_usd ?? price.input_per_million_usd) +
      event.output_tokens * price.output_per_million_usd) /
    1_000_000
  );
}

async function durable<T>(
  input: Pick<Parameters<typeof consumeAgentSession>[0], "bound" | "safety">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      await input.safety.recordFailure(failure);
    } finally {
      try {
        await input.bound.session.cancel("persistence_failure");
      } catch {
        // The safety controller's process-group stop remains authoritative.
      }
    }
    throw failure;
  }
}

function failure(errorCode: AgentErrorCode, providerReason: string): AgentConsumptionResult {
  return { errorCode, kind: "failure", providerReason };
}

function providerReason(event: AgentEvent, fallback: string): string {
  return "provider_reason" in event && typeof event.provider_reason === "string"
    ? event.provider_reason
    : fallback;
}

function validateCaps(attemptTokenCap: number, usdCap: number): void {
  if (!Number.isSafeInteger(attemptTokenCap) || attemptTokenCap <= 0) {
    throw new Error("agent.token_cap_invalid");
  }
  if (!Number.isFinite(usdCap) || usdCap <= 0) throw new Error("agent.usd_cap_invalid");
}
