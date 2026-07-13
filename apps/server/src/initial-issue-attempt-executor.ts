import type { AgentAdapter, TrackerAdapter, WorkspaceRepositoryAdapter } from "@symphony/adapters";
import { AGENT_ERROR_FAILURE_CLASS, type AgentErrorCode, type Issue } from "@symphony/contracts";
import type { FailureClass } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import { finishAttempt, type OpenedDatabase } from "@symphony/persistence";

import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import type { PlannedInitialIssueAttempt } from "./initial-issue-attempt-planner.js";
import { executeInitialIssueDispatch } from "./issue-dispatch-executor.js";
import { prepareIssueWorkspace } from "./issue-workspace-manager.js";

export interface ExecutePlannedInitialIssueAttemptInput {
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
  planned: PlannedInitialIssueAttempt;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  tracker: TrackerAdapter;
  workspaceRoot: string;
}

export async function executePlannedInitialIssueAttempt(
  input: ExecutePlannedInitialIssueAttemptInput,
): Promise<BoundAgentSession> {
  return executeInitialIssueDispatch({
    database: input.database,
    async launchWorker() {
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
        if (
          prepared.population.workspacePath !== input.planned.record.dispatch.attempt.workspacePath
        ) {
          throw new Error("dispatch.workspace_provenance_mismatch");
        }
        return await launchAndBindAgentSession({
          adapter: input.adapter,
          database: input.database,
          request: {
            attemptId: input.planned.attemptId,
            command: input.agentCommand,
            environment: prepared.workerEnvironment,
            preflight: input.planned.preflight,
            profile: input.planned.route.profile,
            prompt: input.planned.prompt,
            title: `issue:${input.issue.id}: ${input.issue.title}`,
            workspacePath: prepared.population.workspacePath,
          },
          safety: input.safety,
        });
      } catch (error) {
        await closeLaunchFailure(input, error);
        throw error;
      }
    },
    now: input.now,
    record: input.planned.record,
    safety: input.safety,
    tracker: input.tracker,
  });
}

async function closeLaunchFailure(
  input: ExecutePlannedInitialIssueAttemptInput,
  error: unknown,
): Promise<void> {
  const terminalResultId = input.newId();
  if (!terminalResultId) throw new Error("dispatch.launch_failure_identity_invalid");
  const failureClass = launchFailureClass(error);
  const revision = input.planned.record.authority.expectation.targetRevision;
  if (revision === null) throw new Error("dispatch.launch_failure_revision_missing");
  try {
    await finishAttempt(input.database, {
      attemptId: input.planned.attemptId,
      costUsd: input.planned.record.dispatch.attempt.costUsd,
      endedAt: input.now(),
      failureClass,
      nextClaim: { mode: "Ready", reason: "launch_failed" },
      reservationId: input.planned.record.dispatch.reservation.id,
      settledLedgers: input.planned.record.dispatch.reservation.ledgers.map((ledger) => ({
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
            revision,
          },
          role: "implementation",
          status: "failed",
          summary: "Initial implementation launch failed before a session was bound.",
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
