import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import { consumeAgentSession } from "./agent-event-consumer.js";
import type { BoundAgentSession } from "./agent-session-binding.js";
import { closeInitialIssueAttempt } from "./initial-issue-attempt-closure.js";
import {
  type ExecutePlannedInitialIssueAttemptInput,
  executePlannedInitialIssueAttempt,
} from "./initial-issue-attempt-executor.js";

export interface StartedInitialIssueAttemptLifecycle {
  bound: BoundAgentSession;
  completion: Promise<AgentConsumptionResult>;
}

type LifecycleInput = ExecutePlannedInitialIssueAttemptInput & {
  attemptTokenCap: number;
  serviceRunId: string;
  usdCap: number;
};

export async function startPlannedInitialIssueAttemptLifecycle(
  input: LifecycleInput,
): Promise<StartedInitialIssueAttemptLifecycle> {
  const bound = await executePlannedInitialIssueAttempt(input);
  return { bound, completion: consumeAndClose(input, bound) };
}

export async function runPlannedInitialIssueAttemptLifecycle(
  input: LifecycleInput,
): Promise<AgentConsumptionResult> {
  const started = await startPlannedInitialIssueAttemptLifecycle(input);
  return started.completion;
}

async function consumeAndClose(
  input: ExecutePlannedInitialIssueAttemptInput & {
    attemptTokenCap: number;
    serviceRunId: string;
    usdCap: number;
  },
  bound: BoundAgentSession,
): Promise<AgentConsumptionResult> {
  const consumption = await consumeAgentSession({
    attemptTokenCap: input.attemptTokenCap,
    bound,
    database: input.database,
    manifest: input.planned.preflight.manifest,
    newId: input.newId,
    safety: input.safety,
    serviceRunId: input.serviceRunId,
    usdCap: input.usdCap,
  });
  const providerRevision = input.planned.record.authority.expectation.targetRevision;
  if (providerRevision === null) throw new Error("attempt_lifecycle.provider_revision_missing");
  await closeInitialIssueAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    issue: input.issue,
    newId: input.newId,
    providerRevision,
    reservationId: input.planned.record.dispatch.reservation.id,
    safety: input.safety,
  });
  return consumption;
}
