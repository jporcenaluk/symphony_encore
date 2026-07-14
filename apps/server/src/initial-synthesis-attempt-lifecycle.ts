import type { AgentAdapter, WorkspaceRepositoryAdapter } from "@symphony/adapters";
import type { SystemJob } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import { createDispatch, type OpenedDatabase } from "@symphony/persistence";

import { type AgentConsumptionResult, consumeAgentSession } from "./agent-event-consumer.js";
import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import type { PlannedInitialSynthesisAttempt } from "./initial-synthesis-attempt-planner.js";
import { closeSynthesisAttempt } from "./synthesis-attempt-closure.js";
import { prepareSystemJobWorkspace } from "./system-job-workspace-manager.js";

export interface StartedInitialSynthesisAttemptLifecycle {
  bound: BoundAgentSession;
  completion: Promise<AgentConsumptionResult>;
}

export async function startPlannedInitialSynthesisAttemptLifecycle(input: {
  adapter: AgentAdapter;
  agentCommand: string;
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  attemptTokenCap: number;
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  job: Extract<SystemJob, { kind: "synthesis" }>;
  maxFailureRetries: number;
  maxPromptTokens: number;
  maxRetryBackoffMs: number;
  maxRules: number;
  newId(): string;
  now(): string;
  planned: PlannedInitialSynthesisAttempt;
  readWorkspaceRevision(workspace: string): Promise<string>;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  retryJitterSample: number;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  usdCap: number;
  workspaceRoot: string;
}): Promise<StartedInitialSynthesisAttemptLifecycle> {
  await durable(input.safety, () => createDispatch(input.database, input.planned.dispatch));
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
      throw new Error("synthesis_dispatch.workspace_provenance_mismatch");
    }
    bound = await launchAndBindAgentSession({
      adapter: input.adapter,
      database: input.database,
      request: {
        attemptId: input.planned.attemptId,
        command: input.agentCommand,
        environment: prepared.workerEnvironment,
        preflight: input.planned.preflight,
        profile: input.planned.route.profile,
        prompt: input.planned.prompt,
        title: `synthesis:${input.job.id}: ${input.job.goal}`,
        workspacePath: prepared.population.workspacePath,
      },
      safety: input.safety,
    });
  } catch (error) {
    await closeSynthesisAttempt({
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
      maxPromptTokens: input.maxPromptTokens,
      maxRetryBackoffMs: input.maxRetryBackoffMs,
      maxRules: input.maxRules,
      newId: input.newId,
      repositoryRevision: input.job.config_snapshot_id,
      reservationId: input.planned.dispatch.reservation.id,
      retryJitterSample: input.retryJitterSample,
      safety: input.safety,
    });
    throw error;
  }
  return { bound, completion: consumeAndClose(input, bound) };
}

async function consumeAndClose(
  input: Parameters<typeof startPlannedInitialSynthesisAttemptLifecycle>[0],
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
  const repositoryRevision = await input.readWorkspaceRevision(
    input.planned.dispatch.attempt.workspacePath,
  );
  return closeSynthesisAttempt({
    attemptId: input.planned.attemptId,
    consumption,
    database: input.database,
    endedAt: input.now(),
    job: input.job,
    maxFailureRetries: input.maxFailureRetries,
    maxPromptTokens: input.maxPromptTokens,
    maxRetryBackoffMs: input.maxRetryBackoffMs,
    maxRules: input.maxRules,
    newId: input.newId,
    repositoryRevision,
    reservationId: input.planned.dispatch.reservation.id,
    retryJitterSample: input.retryJitterSample,
    safety: input.safety,
  });
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
  return (message.replace(/[\r\n\t]+/gu, " ").trim() || "synthesis lifecycle failed").slice(0, 256);
}
