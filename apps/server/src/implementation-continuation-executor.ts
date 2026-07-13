import type {
  AgentAdapter,
  AgentPlanSubmissionDecision,
  WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  createContinuationDispatch,
  finishAttempt,
  type OpenedDatabase,
} from "@symphony/persistence";

import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import type { PlannedImplementationContinuation } from "./implementation-continuation-planner.js";
import {
  gatePlanSubmissionUntilBound,
  launchFailureClass,
} from "./initial-issue-attempt-executor.js";
import { prepareIssueWorkspace } from "./issue-workspace-manager.js";

export interface ExecuteImplementationContinuationInput {
  adapter: AgentAdapter;
  agentCommand: string;
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  issue: Issue;
  newId(): string;
  now(): string;
  onPlanSubmitted: (plan: unknown) => Promise<AgentPlanSubmissionDecision>;
  planned: PlannedImplementationContinuation;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  workspaceRoot: string;
}

export interface BoundImplementationContinuation {
  bound: BoundAgentSession;
  repositoryRevision: string;
}

export async function executeImplementationContinuation(
  input: ExecuteImplementationContinuationInput,
): Promise<BoundImplementationContinuation> {
  await createContinuationDispatch(input.database, {
    dispatch: input.planned.dispatch,
    expectedReadyReason: input.planned.expectedReadyReason,
  });
  const planSubmission = gatePlanSubmissionUntilBound(input.onPlanSubmitted);
  try {
    const prepared = await prepareIssueWorkspace({
      afterCreateCommand: input.afterCreateCommand,
      allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
      beforeRunCommand: input.beforeRunCommand,
      database: input.database,
      hookTimeoutMs: input.hookTimeoutMs,
      issue: input.issue,
      repositoryAdapter: input.repositoryAdapter,
      safety: input.safety,
      sourceEnvironment: input.sourceEnvironment,
      workspaceRoot: input.workspaceRoot,
    });
    if (prepared.population.workspacePath !== input.planned.dispatch.attempt.workspacePath) {
      throw new Error("implementation_continuation.workspace_provenance_mismatch");
    }
    const bound = await launchAndBindAgentSession({
      adapter: input.adapter,
      database: input.database,
      request: {
        attemptId: input.planned.attemptId,
        command: input.agentCommand,
        environment: prepared.workerEnvironment,
        onPlanSubmitted: planSubmission.submit,
        preflight: input.planned.preflight,
        profile: input.planned.route.profile,
        prompt: input.planned.prompt,
        title: `implementation:${input.issue.id}: ${input.issue.title}`,
        workspacePath: prepared.population.workspacePath,
      },
      safety: input.safety,
    });
    planSubmission.bound();
    return { bound, repositoryRevision: prepared.population.baseSha };
  } catch (error) {
    planSubmission.failed(error);
    await closeLaunchFailure(input, error);
    throw error;
  }
}

async function closeLaunchFailure(
  input: ExecuteImplementationContinuationInput,
  error: unknown,
): Promise<void> {
  const terminalResultId = input.newId();
  if (!terminalResultId) {
    throw new Error("implementation_continuation.launch_failure_identity_invalid");
  }
  const failureClass = launchFailureClass(error);
  try {
    await finishAttempt(input.database, {
      attemptId: input.planned.attemptId,
      costUsd: input.planned.dispatch.attempt.costUsd,
      endedAt: input.now(),
      failureClass,
      nextClaim: { mode: "Ready", reason: input.planned.expectedReadyReason },
      reservationId: input.planned.dispatch.reservation.id,
      settledLedgers: input.planned.dispatch.reservation.ledgers.map((ledger) => ({
        actualAmount: 0,
        id: ledger.id,
      })),
      terminalResult: {
        id: terminalResultId,
        kind: "execution_failure",
        payload: {
          evidence: [],
          failure_class: failureClass,
          handoff: {
            acceptance_criteria: input.issue.acceptance_criteria,
            commands: [],
            decisions_fixed: [],
            files_changed: [],
            goal: input.issue.title,
            open_items: input.issue.acceptance_criteria,
            revision: "unknown",
          },
          role: "implementation",
          status: "failed",
          summary: "Implementation continuation launch failed before session binding.",
        },
        role: "implementation",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      workRef: { id: input.issue.id, kind: "issue" },
    });
  } catch (persistenceError) {
    const failure =
      persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError));
    await input.safety.recordFailure(failure);
    throw failure;
  }
}
