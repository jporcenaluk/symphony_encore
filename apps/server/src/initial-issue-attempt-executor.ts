import type { AgentAdapter, TrackerAdapter, WorkspaceRepositoryAdapter } from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import type { OpenedDatabase } from "@symphony/persistence";

import { type BoundAgentSession, launchAndBindAgentSession } from "./agent-session-binding.js";
import type { PlannedInitialIssueAttempt } from "./initial-issue-attempt-planner.js";
import { executeInitialIssueDispatch } from "./issue-dispatch-executor.js";
import { prepareIssueWorkspace } from "./issue-workspace-manager.js";

export async function executePlannedInitialIssueAttempt(input: {
  adapter: AgentAdapter;
  agentCommand: string;
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  issue: Issue;
  now(): string;
  planned: PlannedInitialIssueAttempt;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  tracker: TrackerAdapter;
  workspaceRoot: string;
}): Promise<BoundAgentSession> {
  return executeInitialIssueDispatch({
    database: input.database,
    async launchWorker() {
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
      return launchAndBindAgentSession({
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
    },
    now: input.now,
    record: input.planned.record,
    safety: input.safety,
    tracker: input.tracker,
  });
}
