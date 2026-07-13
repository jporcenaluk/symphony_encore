import { realpath } from "node:fs/promises";

import {
  buildScrubbedWorkerEnvironment,
  type HookExecutionResult,
  issueWorkspacePath,
  type LinuxHookRequest,
  prepareWorkerStateDirectories,
  removeTerminalWorkspace,
  resolveAssignedWorkspace,
  runLinuxHook,
  type WorkspacePopulation,
  type WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  loadWorkspaceCheckout,
  type OpenedDatabase,
  recordWorkspaceCheckout,
} from "@symphony/persistence";

type WorkspaceIssue = Pick<Issue, "id" | "identifier" | "repo_name" | "repo_owner">;
type HookRunner = (request: LinuxHookRequest) => Promise<HookExecutionResult>;

export async function prepareIssueWorkspace(input: {
  afterCreateCommand: string | null;
  allowlistedEnvironmentNames: readonly string[];
  beforeRunCommand: string | null;
  database: OpenedDatabase["database"];
  hookRunner?: HookRunner;
  hookTimeoutMs: number;
  issue: WorkspaceIssue;
  onHookResult?: (kind: "after_create" | "before_run", result: HookExecutionResult) => void;
  repositoryAdapter: WorkspaceRepositoryAdapter;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  workspaceRoot: string;
}): Promise<{ population: WorkspacePopulation; workerEnvironment: Record<string, string> }> {
  const repository = `${input.issue.repo_owner}/${input.issue.repo_name}`;
  const workRef = { id: input.issue.id, kind: "issue" as const };
  const existing = await durable(input.safety, () =>
    loadWorkspaceCheckout(input.database, workRef),
  );
  let population: WorkspacePopulation;
  if (existing) {
    population = {
      baseRef: existing.baseRef,
      baseSha: existing.baseSha,
      checkoutMethod: existing.checkoutMethod,
      createdAt: existing.createdAt,
      localBranch: existing.localBranch,
      repository: existing.repository,
      workspacePath: existing.workspacePath,
    };
    await validatePopulation(input.workspaceRoot, input.issue.identifier, repository, population);
  } else {
    population = await input.repositoryAdapter.populateIssueWorkspace({
      identifier: input.issue.identifier,
      repository,
      workspaceRoot: input.workspaceRoot,
    });
    try {
      await validatePopulation(input.workspaceRoot, input.issue.identifier, repository, population);
      await prepareWorkerStateDirectories(population.workspacePath);
      if (input.afterCreateCommand) {
        await runFatalHook(
          input,
          population.workspacePath,
          "after_create",
          input.afterCreateCommand,
        );
      }
    } catch (error) {
      await removeTerminalWorkspace({
        assignedWorkspace: population.workspacePath,
        workspaceRoot: input.workspaceRoot,
      });
      throw error;
    }
    await durable(input.safety, () =>
      recordWorkspaceCheckout(input.database, {
        ...population,
        workRef,
      }),
    );
  }

  await prepareWorkerStateDirectories(population.workspacePath);
  if (input.beforeRunCommand) {
    await runFatalHook(input, population.workspacePath, "before_run", input.beforeRunCommand);
  }
  return {
    population,
    workerEnvironment: buildScrubbedWorkerEnvironment(
      population.workspacePath,
      input.sourceEnvironment,
      input.allowlistedEnvironmentNames,
    ),
  };
}

async function validatePopulation(
  workspaceRoot: string,
  identifier: string,
  repository: string,
  population: WorkspacePopulation,
): Promise<void> {
  if (population.repository !== repository) throw new Error("workspace.repository_mismatch");
  const resolvedRoot = await realpath(workspaceRoot);
  const expected = issueWorkspacePath(resolvedRoot, identifier);
  const resolved = await resolveAssignedWorkspace(resolvedRoot, population.workspacePath);
  if (resolved !== expected) throw new Error("workspace.assignment_mismatch");
}

async function runFatalHook(
  input: {
    allowlistedEnvironmentNames: readonly string[];
    hookRunner?: HookRunner;
    hookTimeoutMs: number;
    onHookResult?: (kind: "after_create" | "before_run", result: HookExecutionResult) => void;
    sourceEnvironment: Readonly<Record<string, string | undefined>>;
    workspaceRoot: string;
  },
  workspace: string,
  kind: "after_create" | "before_run",
  command: string,
): Promise<void> {
  const result = await (input.hookRunner ?? runLinuxHook)({
    allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
    command,
    kind,
    sourceEnvironment: input.sourceEnvironment,
    timeoutMs: input.hookTimeoutMs,
    workspace,
    workspaceRoot: input.workspaceRoot,
  });
  input.onHookResult?.(kind, result);
  if (result.status !== "passed") throw new Error(`workspace.${kind}_failed`);
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
