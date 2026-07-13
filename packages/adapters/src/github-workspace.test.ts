import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GhCliApiClient } from "./gh-cli-api.js";
import {
  createGitHubWorkspaceRepositoryAdapter,
  createNodeWorkspaceCommandRunner,
  syncWorkspaceToPublishedBranch,
  type WorkspaceCommandRunner,
} from "./github-workspace.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function api(data: unknown): GhCliApiClient {
  return {
    graphql: vi.fn(async () => ({ data, requestId: "REQ-1" })) as GhCliApiClient["graphql"],
    rest: vi.fn() as GhCliApiClient["rest"],
  };
}

describe("GitHub trusted workspace population", () => {
  it("resolves the default branch, clones, creates a local branch, and verifies the exact SHA", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-workspace-"));
    directories.push(root);
    const workspace = path.join(root, "ORG_repo_42");
    const baseSha = "0123456789abcdef0123456789abcdef01234567";
    const run = vi.fn<WorkspaceCommandRunner["run"]>(async (request) => {
      if (request.command === "gh") {
        await mkdir(workspace);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.arguments.includes("rev-parse")) {
        return { exitCode: 0, stderr: "", stdout: `${baseSha}\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    const adapter = createGitHubWorkspaceRepositoryAdapter({
      api: api({
        repository: {
          defaultBranchRef: { name: "main", target: { oid: baseSha } },
          nameWithOwner: "ORG/repo",
        },
      }),
      commandRunner: { run },
      environment: {
        GH_TOKEN: "trusted-token",
        HOME: "/home/service",
        PATH: "/usr/bin:/bin",
        UNRELATED_SECRET: "must-not-cross",
      },
      now: () => "2026-07-13T10:00:02Z",
      timeoutMs: 5_000,
    });

    await expect(
      adapter.populateIssueWorkspace({
        identifier: "ORG/repo#42",
        repository: "ORG/repo",
        workspaceRoot: root,
      }),
    ).resolves.toEqual({
      baseRef: "main",
      baseSha,
      checkoutMethod: "trusted_repository_adapter",
      createdAt: "2026-07-13T10:00:02Z",
      localBranch: expect.stringMatching(/^symphony\/ORG-repo-42-[a-f0-9]{12}$/u),
      repository: "ORG/repo",
      workspacePath: workspace,
    });

    expect(run).toHaveBeenNthCalledWith(1, {
      arguments: ["repo", "clone", "ORG/repo", workspace, "--", "--no-checkout"],
      command: "gh",
      cwd: root,
      environment: {
        GH_TOKEN: "trusted-token",
        HOME: "/home/service",
        PATH: "/usr/bin:/bin",
      },
      maxOutputBytes: 1_000_000,
      timeoutMs: 5_000,
    });
    const switchRequest = run.mock.calls[1]?.[0];
    expect(switchRequest).toMatchObject({
      arguments: ["-C", workspace, "switch", "--create", expect.any(String), baseSha],
      command: "git",
      cwd: root,
      environment: { HOME: "/home/service", PATH: "/usr/bin:/bin" },
    });
    expect(switchRequest?.environment).not.toHaveProperty("GH_TOKEN");
    expect(run.mock.calls[2]?.[0]).toMatchObject({
      arguments: ["-C", workspace, "rev-parse", "HEAD"],
      command: "git",
    });
  });

  it("fails closed and removes a partial checkout when local branch creation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-workspace-"));
    directories.push(root);
    const workspace = path.join(root, "ORG_repo_42");
    const run = vi.fn<WorkspaceCommandRunner["run"]>(async (request) => {
      if (request.command === "gh") {
        await mkdir(workspace);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return { exitCode: 1, stderr: "git failed", stdout: "" };
    });
    const adapter = createGitHubWorkspaceRepositoryAdapter({
      api: api({
        repository: {
          defaultBranchRef: {
            name: "main",
            target: { oid: "0123456789abcdef0123456789abcdef01234567" },
          },
          nameWithOwner: "ORG/repo",
        },
      }),
      commandRunner: { run },
      environment: { PATH: "/usr/bin:/bin" },
      now: () => "2026-07-13T10:00:02Z",
      timeoutMs: 5_000,
    });

    await expect(
      adapter.populateIssueWorkspace({
        identifier: "ORG/repo#42",
        repository: "ORG/repo",
        workspaceRoot: root,
      }),
    ).rejects.toThrow("workspace.git_failed");
    await expect(
      import("node:fs/promises").then(({ access }) => access(workspace)),
    ).rejects.toThrow();
  });

  it("rejects incomplete or mismatched repository metadata before cloning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-workspace-"));
    directories.push(root);
    const run = vi.fn<WorkspaceCommandRunner["run"]>();
    const adapter = createGitHubWorkspaceRepositoryAdapter({
      api: api({
        repository: {
          defaultBranchRef: { name: "main", target: { oid: "invalid" } },
          nameWithOwner: "other/repo",
        },
      }),
      commandRunner: { run },
      environment: {},
      now: () => "2026-07-13T10:00:02Z",
      timeoutMs: 5_000,
    });

    await expect(
      adapter.populateIssueWorkspace({
        identifier: "ORG/repo#42",
        repository: "ORG/repo",
        workspaceRoot: root,
      }),
    ).rejects.toThrow("workspace.repository_metadata_invalid");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the local argv boundary without a shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-workspace-command-"));
    directories.push(root);
    const executable = path.join(root, "git");
    await writeFile(executable, "#!/bin/sh\nprintf '%s' \"$*\"\n");
    await chmod(executable, 0o755);

    await expect(
      createNodeWorkspaceCommandRunner().run({
        arguments: ["rev-parse", "HEAD"],
        command: "git",
        cwd: root,
        environment: { PATH: root },
        maxOutputBytes: 1_000,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "rev-parse HEAD" });
  });

  it("synchronizes a clean assigned workspace to an exact published branch revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-workspace-sync-"));
    directories.push(root);
    const workspace = path.join(root, "ORG_repo_42");
    await mkdir(workspace);
    const headSha = "fedcba9876543210fedcba9876543210fedcba98";
    const run = vi.fn<WorkspaceCommandRunner["run"]>(async (request) => {
      if (request.arguments.includes("status")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.arguments.includes("rev-parse")) {
        return { exitCode: 0, stderr: "", stdout: `${headSha}\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await expect(
      syncWorkspaceToPublishedBranch({
        branch: "symphony/issue-1",
        commandRunner: { run },
        environment: { HOME: "/home/service", PATH: "/usr/bin:/bin", SECRET: "no" },
        expectedHeadSha: headSha,
        timeoutMs: 5_000,
        workspace,
        workspaceRoot: root,
      }),
    ).resolves.toBe(headSha);
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        arguments: [
          "-C",
          workspace,
          "fetch",
          "--force",
          "origin",
          "refs/heads/symphony/issue-1:refs/remotes/origin/symphony/issue-1",
        ],
        environment: { HOME: "/home/service", PATH: "/usr/bin:/bin" },
      }),
    );
    expect(run).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        arguments: ["-C", workspace, "reset", "--hard", headSha],
      }),
    );
  });
});
