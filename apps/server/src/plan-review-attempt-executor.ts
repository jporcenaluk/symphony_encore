import type { AgentAdapter, WorkspaceRepositoryAdapter } from "@symphony/adapters";
import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Issue,
  type Plan,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  createContinuationDispatch,
  finishAttempt,
  type OpenedDatabase,
} from "@symphony/persistence";

import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import { prepareIssueWorkspace } from "./issue-workspace-manager.js";
import type { PlannedPlanReviewAttempt } from "./plan-review-attempt-planner.js";

export interface ExecutePlannedPlanReviewAttemptInput {
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
  plan: Plan;
  planned: PlannedPlanReviewAttempt;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  workspaceRoot: string;
}

export interface BoundPlanReviewAttempt {
  bound: BoundAgentSession;
  repositoryRevision: string;
}

export async function executePlannedPlanReviewAttempt(
  input: ExecutePlannedPlanReviewAttemptInput,
): Promise<BoundPlanReviewAttempt> {
  await createContinuationDispatch(input.database, {
    dispatch: input.planned.dispatch,
    expectedReadyReason: "plan_review_required",
  });
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
      throw new Error("plan_review.workspace_provenance_mismatch");
    }
    const bound = await launchAndBindAgentSession({
      adapter: input.adapter,
      database: input.database,
      request: {
        attemptId: input.planned.attemptId,
        command: input.agentCommand,
        environment: prepared.workerEnvironment,
        preflight: input.planned.preflight,
        profile: input.planned.route.profile,
        prompt: input.planned.prompt,
        title: `plan-review:${input.issue.id}: ${input.issue.title}`,
        workspacePath: prepared.population.workspacePath,
      },
      safety: input.safety,
    });
    return { bound, repositoryRevision: prepared.population.baseSha };
  } catch (error) {
    await closeLaunchFailure(input, error);
    throw error;
  }
}

async function closeLaunchFailure(
  input: ExecutePlannedPlanReviewAttemptInput,
  error: unknown,
): Promise<void> {
  const terminalResultId = input.newId();
  if (!terminalResultId) throw new Error("plan_review.launch_failure_identity_invalid");
  const failureClass = launchFailureClass(error);
  try {
    await finishAttempt(input.database, {
      attemptId: input.planned.attemptId,
      costUsd: input.planned.dispatch.attempt.costUsd,
      endedAt: input.now(),
      failureClass,
      nextClaim: { mode: "Ready", reason: "plan_review_launch_failed" },
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
          role: "plan_review",
          status: "failed",
          summary: "Plan-review launch failed before a session was bound.",
        },
        role: "plan_review",
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

function launchFailureClass(error: unknown): FailureClass {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : error instanceof Error
        ? error.message
        : null;
  if (typeof candidate === "string" && candidate in AGENT_ERROR_FAILURE_CLASS) {
    const mapped = AGENT_ERROR_FAILURE_CLASS[candidate as AgentErrorCode];
    return mapped === "budget_exhausted" ? "agent_process" : mapped;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("configuration.") || message.includes("_hook_failed")) {
    return "configuration";
  }
  if (message.startsWith("policy.")) return "policy";
  return "infrastructure";
}
