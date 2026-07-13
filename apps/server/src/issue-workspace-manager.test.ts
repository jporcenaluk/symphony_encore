import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { issueWorkspacePath, type WorkspaceRepositoryAdapter } from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  loadWorkspaceCheckout,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareIssueWorkspace } from "./issue-workspace-manager.js";

let directory: string;
let opened: OpenedDatabase;
let workspaceRoot: string;

const issue = {
  id: "issue-1",
  identifier: "ORG/repo#42",
  repo_name: "repo",
  repo_owner: "ORG",
} as Pick<Issue, "id" | "identifier" | "repo_name" | "repo_owner">;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-issue-workspace-manager-"));
  workspaceRoot = path.join(directory, "workspaces");
  await mkdir(workspaceRoot);
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, ?, 'config-1',
        'standard', 'model', 'medium', '[]', 'standard', '2026-07-13T10:00:00Z', 'created'
      )`,
    )
    .run(issueWorkspacePath(workspaceRoot, issue.identifier));
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Running', '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', '2026-07-13T10:02:00Z', 'Todo', 'dispatch'
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function repositoryAdapter(): WorkspaceRepositoryAdapter {
  return {
    populateIssueWorkspace: vi.fn(async (input) => {
      const workspacePath = issueWorkspacePath(input.workspaceRoot, input.identifier);
      await mkdir(workspacePath);
      return {
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        checkoutMethod: "trusted_repository_adapter" as const,
        createdAt: "2026-07-13T10:00:01Z",
        localBranch: "symphony/ORG-repo-42-deadbeef0000",
        repository: input.repository,
        workspacePath,
      };
    }),
  };
}

describe("issue workspace preparation", () => {
  it("runs after_create before provenance, reuses the durable checkout, and runs before_run each time", async () => {
    const adapter = repositoryAdapter();
    const hooks: string[] = [];
    const hookRunner = vi.fn(async (request: { kind: string }) => {
      hooks.push(request.kind);
      return { exitCode: 0, fatal: true, status: "passed" as const, stderr: "", stdout: "" };
    });
    const common = {
      afterCreateCommand: "setup",
      allowlistedEnvironmentNames: ["LANG", "GITHUB_TOKEN"],
      beforeRunCommand: "prepare",
      database: opened.database,
      hookRunner,
      hookTimeoutMs: 5_000,
      issue,
      repositoryAdapter: adapter,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      sourceEnvironment: { GITHUB_TOKEN: "secret", LANG: "en_GB.UTF-8" },
      workspaceRoot,
    };

    const first = await prepareIssueWorkspace(common);
    const second = await prepareIssueWorkspace(common);

    expect(adapter.populateIssueWorkspace).toHaveBeenCalledOnce();
    expect(hooks).toEqual(["after_create", "before_run", "before_run"]);
    expect(first.population).toEqual(second.population);
    expect(first.workerEnvironment).toMatchObject({
      LANG: "en_GB.UTF-8",
      HOME: path.join(first.population.workspacePath, ".home"),
    });
    expect(first.workerEnvironment).not.toHaveProperty("GITHUB_TOKEN");
    await expect(
      loadWorkspaceCheckout(opened.database, { id: issue.id, kind: "issue" }),
    ).resolves.toMatchObject({
      baseSha: first.population.baseSha,
      workspacePath: first.population.workspacePath,
    });
  });

  it("removes a new workspace and does not commit provenance when after_create fails", async () => {
    const adapter = repositoryAdapter();
    const safety = new PersistenceSafetyController(vi.fn(async () => undefined));
    await expect(
      prepareIssueWorkspace({
        afterCreateCommand: "setup",
        allowlistedEnvironmentNames: [],
        beforeRunCommand: null,
        database: opened.database,
        hookRunner: vi.fn(async () => ({
          exitCode: 1,
          fatal: true,
          status: "failed" as const,
          stderr: "failed",
          stdout: "",
        })),
        hookTimeoutMs: 5_000,
        issue,
        repositoryAdapter: adapter,
        safety,
        sourceEnvironment: {},
        workspaceRoot,
      }),
    ).rejects.toThrow("workspace.after_create_failed");
    await expect(
      loadWorkspaceCheckout(opened.database, { id: issue.id, kind: "issue" }),
    ).resolves.toBeUndefined();
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(issueWorkspacePath(workspaceRoot, issue.identifier)),
      ),
    ).rejects.toThrow();
    expect(safety.canDispatch()).toBe(true);
  });
});
