import type { AgentAdapter, WorkspaceRepositoryAdapter } from "@symphony/adapters";
import {
  AGENT_ERROR_FAILURE_CLASS,
  type AgentErrorCode,
  type Issue,
  type SystemJob,
} from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  createContinuationDispatch,
  finishAttempt,
  type OpenedDatabase,
} from "@symphony/persistence";

import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import type { PlannedIntegrativeReviewAttempt } from "./integrative-review-attempt-planner.js";
import { prepareIssueWorkspace } from "./issue-workspace-manager.js";
import { prepareSystemJobWorkspace } from "./system-job-workspace-manager.js";

export interface ExecutePlannedIntegrativeReviewAttemptInput {
  adapter: AgentAdapter;
  agentCommand: string;
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  issue: Issue | Extract<SystemJob, { kind: "repair" }>;
  newId(): string;
  now(): string;
  planned: PlannedIntegrativeReviewAttempt;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  workspaceRoot: string;
}

export interface BoundIntegrativeReviewAttempt {
  bound: BoundAgentSession;
}

export async function executePlannedIntegrativeReviewAttempt(
  input: ExecutePlannedIntegrativeReviewAttemptInput,
): Promise<BoundIntegrativeReviewAttempt> {
  return executePlannedReviewAttempt(input, {
    expectedReadyReason: "review_required",
    launchFailureReason: "integrative_review_launch_failed",
    role: "integrative_review",
    title: `integrative-review:${input.issue.id}: ${workTitle(input.issue)}`,
  });
}

export async function executePlannedSpecialistReviewAttempt(
  input: ExecutePlannedIntegrativeReviewAttemptInput & { specialistName: string },
): Promise<BoundIntegrativeReviewAttempt> {
  return executePlannedReviewAttempt(input, {
    expectedReadyReason: `specialist_review_required:${encodeURIComponent(input.specialistName)}`,
    launchFailureReason: `specialist_review_launch_failed:${encodeURIComponent(input.specialistName)}`,
    role: "specialist_review",
    title: `specialist-review:${input.specialistName}:${input.issue.id}: ${workTitle(input.issue)}`,
  });
}

export async function executePlannedAdjudicationAttempt(
  input: ExecutePlannedIntegrativeReviewAttemptInput,
): Promise<BoundIntegrativeReviewAttempt> {
  return executePlannedReviewAttempt(input, {
    expectedReadyReason: "adjudication_required",
    launchFailureReason: "adjudication_launch_failed",
    role: "adjudication",
    title: `adjudication:${input.issue.id}: ${workTitle(input.issue)}`,
  });
}

async function executePlannedReviewAttempt(
  input: ExecutePlannedIntegrativeReviewAttemptInput,
  mode: {
    expectedReadyReason: string;
    launchFailureReason: string;
    role: "integrative_review" | "specialist_review" | "adjudication";
    title: string;
  },
): Promise<BoundIntegrativeReviewAttempt> {
  await createContinuationDispatch(input.database, {
    dispatch: input.planned.dispatch,
    expectedReadyReason: mode.expectedReadyReason,
  });
  try {
    const prepared =
      "kind" in input.issue
        ? await prepareSystemJobWorkspace({
            afterCreateCommand: input.afterCreateCommand,
            allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
            beforeRunCommand: input.beforeRunCommand,
            database: input.database,
            hookTimeoutMs: input.hookTimeoutMs,
            job: input.issue,
            repositoryAdapter: input.repositoryAdapter,
            safety: input.safety,
            sourceEnvironment: input.sourceEnvironment,
            workspaceRoot: input.workspaceRoot,
          })
        : await prepareIssueWorkspace({
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
    if (
      prepared.population.workspacePath !== input.planned.dispatch.attempt.workspacePath ||
      prepared.population.baseSha !== input.planned.context.baseSha
    ) {
      throw new Error("review.workspace_provenance_mismatch");
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
        title: mode.title,
        workspacePath: prepared.population.workspacePath,
      },
      safety: input.safety,
    });
    return { bound };
  } catch (error) {
    await closeLaunchFailure(input, error, mode);
    throw error;
  }
}

function workTitle(work: Issue | Extract<SystemJob, { kind: "repair" }>): string {
  return "kind" in work ? work.goal : work.title;
}

function reviewWorkRef(work: Issue | Extract<SystemJob, { kind: "repair" }>): {
  id: string;
  kind: "issue" | "system_job";
} {
  return "kind" in work ? { id: work.id, kind: "system_job" } : { id: work.id, kind: "issue" };
}

async function closeLaunchFailure(
  input: ExecutePlannedIntegrativeReviewAttemptInput,
  error: unknown,
  mode: {
    launchFailureReason: string;
    role: "integrative_review" | "specialist_review" | "adjudication";
  },
): Promise<void> {
  const resultId = input.newId();
  if (!resultId) throw new Error("review.launch_failure_identity_invalid");
  const failureClass = launchFailureClass(error);
  try {
    await finishAttempt(input.database, {
      attemptId: input.planned.attemptId,
      costUsd: input.planned.dispatch.attempt.costUsd,
      endedAt: input.now(),
      failureClass,
      nextClaim: { mode: "Ready", reason: mode.launchFailureReason },
      reservationId: input.planned.dispatch.reservation.id,
      settledLedgers: input.planned.dispatch.reservation.ledgers.map((ledger) => ({
        actualAmount: 0,
        id: ledger.id,
      })),
      terminalResult: {
        id: resultId,
        kind: "execution_failure",
        payload: {
          evidence: [],
          failure_class: failureClass,
          handoff: {
            acceptance_criteria: input.issue.acceptance_criteria,
            commands: [],
            decisions_fixed: [],
            files_changed: [...input.planned.context.changedFiles],
            goal: workTitle(input.issue),
            open_items: input.issue.acceptance_criteria,
            revision: input.planned.context.targetSha,
          },
          role: mode.role,
          status: "failed",
          summary: `${mode.role} launch failed before a session was bound.`,
        },
        role: mode.role,
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      workRef: reviewWorkRef(input.issue),
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
  if (message.startsWith("configuration.") || message.includes("_hook_failed"))
    return "configuration";
  if (message.startsWith("policy.")) return "policy";
  return "infrastructure";
}
