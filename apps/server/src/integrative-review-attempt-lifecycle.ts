import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import { consumeAgentSession } from "./agent-event-consumer.js";
import { closeIntegrativeReviewAttempt } from "./integrative-review-attempt-closure.js";
import {
  type ExecutePlannedIntegrativeReviewAttemptInput,
  executePlannedIntegrativeReviewAttempt,
} from "./integrative-review-attempt-executor.js";

type LifecycleInput = ExecutePlannedIntegrativeReviewAttemptInput & {
  attemptTokenCap: number;
  serviceRunId: string;
  usdCap: number;
};

export interface StartedIntegrativeReviewAttemptLifecycle {
  bound: Awaited<ReturnType<typeof executePlannedIntegrativeReviewAttempt>>["bound"];
  completion: Promise<AgentConsumptionResult>;
}

export async function startPlannedIntegrativeReviewAttemptLifecycle(
  input: LifecycleInput,
): Promise<StartedIntegrativeReviewAttemptLifecycle> {
  const started = await executePlannedIntegrativeReviewAttempt(input);
  return { bound: started.bound, completion: consumeAndClose(input, started) };
}

async function consumeAndClose(
  input: LifecycleInput,
  started: Awaited<ReturnType<typeof executePlannedIntegrativeReviewAttempt>>,
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
  return closeIntegrativeReviewAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    context: input.planned.context,
    database: input.database,
    endedAt: input.now(),
    issue: input.issue,
    newId: input.newId,
    reservationId: input.planned.dispatch.reservation.id,
    safety: input.safety,
  });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.replace(/[\r\n\t]+/gu, " ").trim() || "agent event stream failed").slice(0, 256);
}
