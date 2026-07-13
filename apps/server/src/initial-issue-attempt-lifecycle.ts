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
  maxReworkCycles: number;
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
    maxReworkCycles: number;
    serviceRunId: string;
    usdCap: number;
  },
  bound: BoundAgentSession,
): Promise<AgentConsumptionResult> {
  let consumption: AgentConsumptionResult;
  try {
    consumption = await consumeAgentSession({
      attemptTokenCap: input.attemptTokenCap,
      bound,
      database: input.database,
      manifest: input.planned.preflight.manifest,
      newId: input.newId,
      safety: input.safety,
      serviceRunId: input.serviceRunId,
      usdCap: input.usdCap,
    });
  } catch (error) {
    if (!input.safety.canDispatch()) throw error;
    try {
      await bound.session.cancel("process_exit");
      await bound.session.waitForExit();
    } catch (terminationError) {
      const failure =
        terminationError instanceof Error ? terminationError : new Error(String(terminationError));
      await input.safety.recordFailure(failure);
      throw failure;
    }
    consumption = {
      errorCode: "process_exit",
      kind: "failure",
      providerReason: boundedErrorMessage(error),
    };
  }
  const providerRevision = input.planned.record.authority.expectation.targetRevision;
  if (providerRevision === null) throw new Error("attempt_lifecycle.provider_revision_missing");
  await closeInitialIssueAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    issue: input.issue,
    maxReworkCycles: input.maxReworkCycles,
    newId: input.newId,
    providerRevision,
    reservationId: input.planned.record.dispatch.reservation.id,
    safety: input.safety,
  });
  return consumption;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "agent event stream failed").slice(0, 256);
}
