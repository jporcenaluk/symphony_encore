import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import { consumeAgentSession } from "./agent-event-consumer.js";
import {
  type BoundImplementationContinuation,
  type ExecuteImplementationContinuationInput,
  executeImplementationContinuation,
} from "./implementation-continuation-executor.js";
import { closeInitialIssueAttempt } from "./initial-issue-attempt-closure.js";

type LifecycleInput = ExecuteImplementationContinuationInput & {
  attemptTokenCap: number;
  maxFailureRetries: number;
  maxRetryBackoffMs: number;
  maxReworkCycles: number;
  retryJitterSample: number;
  serviceRunId: string;
  usdCap: number;
};

export interface StartedImplementationContinuationLifecycle {
  bound: BoundImplementationContinuation["bound"];
  completion: Promise<AgentConsumptionResult>;
}

export async function startPlannedImplementationContinuationLifecycle(
  input: LifecycleInput,
): Promise<StartedImplementationContinuationLifecycle> {
  const started = await executeImplementationContinuation(input);
  return { bound: started.bound, completion: consumeAndClose(input, started) };
}

export async function runPlannedImplementationContinuationLifecycle(
  input: LifecycleInput,
): Promise<AgentConsumptionResult> {
  const started = await startPlannedImplementationContinuationLifecycle(input);
  return started.completion;
}

async function consumeAndClose(
  input: LifecycleInput,
  started: BoundImplementationContinuation,
): Promise<AgentConsumptionResult> {
  let consumption: AgentConsumptionResult;
  try {
    consumption = await consumeAgentSession({
      attemptTokenCap: input.attemptTokenCap,
      bound: started.bound,
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
      await started.bound.session.cancel("process_exit");
      await started.bound.session.waitForExit();
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
  await closeInitialIssueAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    issue: input.issue,
    maxFailureRetries: input.maxFailureRetries,
    maxRetryBackoffMs: input.maxRetryBackoffMs,
    maxReworkCycles: input.maxReworkCycles,
    newId: input.newId,
    providerRevision: started.repositoryRevision,
    reservationId: input.planned.dispatch.reservation.id,
    retryJitterSample: input.retryJitterSample,
    safety: input.safety,
  });
  return consumption;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "agent event stream failed").slice(0, 256);
}
