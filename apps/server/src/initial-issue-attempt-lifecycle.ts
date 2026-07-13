import type { AgentConsumptionResult } from "./agent-event-consumer.js";
import { consumeAgentSession } from "./agent-event-consumer.js";
import { closeInitialIssueAttempt } from "./initial-issue-attempt-closure.js";
import {
  type ExecutePlannedInitialIssueAttemptInput,
  executePlannedInitialIssueAttempt,
} from "./initial-issue-attempt-executor.js";

export async function runPlannedInitialIssueAttemptLifecycle(
  input: ExecutePlannedInitialIssueAttemptInput & {
    attemptTokenCap: number;
    serviceRunId: string;
    usdCap: number;
  },
): Promise<AgentConsumptionResult> {
  const bound = await executePlannedInitialIssueAttempt(input);
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
