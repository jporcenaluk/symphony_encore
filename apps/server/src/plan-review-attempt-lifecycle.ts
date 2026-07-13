import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import { consumeAgentSession } from "./agent-event-consumer.js";
import { closePlanReviewAttempt } from "./plan-review-attempt-closure.js";
import {
  type ExecutePlannedPlanReviewAttemptInput,
  executePlannedPlanReviewAttempt,
} from "./plan-review-attempt-executor.js";

type LifecycleInput = ExecutePlannedPlanReviewAttemptInput & {
  attemptTokenCap: number;
  maxPlanRevisions: number;
  serviceRunId: string;
  usdCap: number;
};

export async function runPlannedPlanReviewAttemptLifecycle(
  input: LifecycleInput,
): Promise<AgentConsumptionResult> {
  const started = await executePlannedPlanReviewAttempt(input);
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
  return closePlanReviewAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    issue: input.issue,
    maxPlanRevisions: input.maxPlanRevisions,
    newId: input.newId,
    plan: input.plan,
    repositoryRevision: started.repositoryRevision,
    reservationId: input.planned.dispatch.reservation.id,
    safety: input.safety,
  });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "agent event stream failed").slice(0, 256);
}
