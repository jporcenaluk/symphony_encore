import type {
  AgentAdapter,
  AgentPlanSubmissionDecision,
  WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import type { SystemJob } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import { createDispatch, type OpenedDatabase } from "@symphony/persistence";

import { type AgentConsumptionResult, consumeAgentSession } from "./agent-event-consumer.js";
import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import { gatePlanSubmissionUntilBound } from "./initial-issue-attempt-executor.js";
import { closeInitialSystemJobAttempt } from "./initial-system-job-attempt-closure.js";
import type { PlannedInitialSystemJobAttempt } from "./initial-system-job-attempt-planner.js";
import { prepareSystemJobWorkspace } from "./system-job-workspace-manager.js";

export interface StartedInitialSystemJobAttemptLifecycle {
  bound: BoundAgentSession;
  completion: Promise<AgentConsumptionResult>;
}

export async function startPlannedInitialSystemJobAttemptLifecycle(input: {
  adapter: AgentAdapter;
  agentCommand: string;
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  attemptTokenCap: number;
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  job: Extract<SystemJob, { kind: "repair" }>;
  maxFailureRetries: number;
  maxRetryBackoffMs: number;
  maxReworkCycles: number;
  newId(): string;
  now(): string;
  onPlanSubmitted?: (plan: unknown) => Promise<AgentPlanSubmissionDecision>;
  planned: PlannedInitialSystemJobAttempt;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  retryJitterSample: number;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  usdCap: number;
  workspaceRoot: string;
}): Promise<StartedInitialSystemJobAttemptLifecycle> {
  await durable(input.safety, () => createDispatch(input.database, input.planned.dispatch));
  const planSubmission = input.onPlanSubmitted
    ? gatePlanSubmissionUntilBound(input.onPlanSubmitted)
    : undefined;
  let revision = input.job.config_snapshot_id;
  let bound: BoundAgentSession;
  try {
    const prepared = await prepareSystemJobWorkspace({
      afterCreateCommand: input.afterCreateCommand,
      allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
      beforeRunCommand: input.beforeRunCommand,
      database: input.database,
      hookTimeoutMs: input.hookTimeoutMs,
      job: input.job,
      repositoryAdapter: input.repositoryAdapter,
      safety: input.safety,
      sourceEnvironment: input.sourceEnvironment,
      workspaceRoot: input.workspaceRoot,
    });
    if (prepared.population.workspacePath !== input.planned.dispatch.attempt.workspacePath) {
      throw new Error("system_job_dispatch.workspace_provenance_mismatch");
    }
    revision = prepared.population.baseSha;
    bound = await launchAndBindAgentSession({
      adapter: input.adapter,
      database: input.database,
      request: {
        attemptId: input.planned.attemptId,
        command: input.agentCommand,
        environment: prepared.workerEnvironment,
        ...(planSubmission ? { onPlanSubmitted: planSubmission.submit } : {}),
        preflight: input.planned.preflight,
        profile: input.planned.route.profile,
        prompt: input.planned.prompt,
        title: `system_job:${input.job.id}: ${input.job.goal}`,
        workspacePath: prepared.population.workspacePath,
      },
      safety: input.safety,
    });
    planSubmission?.bound();
  } catch (error) {
    planSubmission?.failed(error);
    await closeInitialSystemJobAttempt({
      attemptId: input.planned.attemptId,
      consumption: {
        errorCode: "process_exit",
        kind: "failure",
        providerReason: boundedErrorMessage(error),
      },
      database: input.database,
      endedAt: input.now(),
      job: input.job,
      maxFailureRetries: input.maxFailureRetries,
      maxRetryBackoffMs: input.maxRetryBackoffMs,
      maxReworkCycles: input.maxReworkCycles,
      newId: input.newId,
      reservationId: input.planned.dispatch.reservation.id,
      retryJitterSample: input.retryJitterSample,
      revision,
      safety: input.safety,
    });
    throw error;
  }
  return { bound, completion: consumeAndClose(input, bound, revision) };
}

async function consumeAndClose(
  input: Parameters<typeof startPlannedInitialSystemJobAttemptLifecycle>[0],
  bound: BoundAgentSession,
  revision: string,
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
  await closeInitialSystemJobAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    job: input.job,
    maxFailureRetries: input.maxFailureRetries,
    maxRetryBackoffMs: input.maxRetryBackoffMs,
    maxReworkCycles: input.maxReworkCycles,
    newId: input.newId,
    reservationId: input.planned.dispatch.reservation.id,
    retryJitterSample: input.retryJitterSample,
    revision,
    safety: input.safety,
  });
  return consumption;
}

async function durable<T>(
  safety: PersistenceSafetyController,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await safety.recordFailure(failure);
    throw failure;
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "agent lifecycle failed").slice(0, 256);
}
