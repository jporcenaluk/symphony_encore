import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  it("uses linear branch-label trimming while preserving adversarial identifier semantics", async () => {
    const source = await readFile(new URL("./github-workspace.ts", import.meta.url), "utf8");
    expect(source).not.toContain('.replace(/^-+|-+$/gu, "")');

    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-branch-name-"));
    directories.push(root);
    const workspace = path.join(await realpath(root), "---ORG_repo_42---");
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
      environment: {},
      timeoutMs: 5_000,
    });

    await adapter.populateIssueWorkspace({
      identifier: "---ORG/repo#42---",
      repository: "ORG/repo",
      workspaceRoot: root,
    });

    expect(run.mock.calls[1]?.[0].arguments[4]).toMatch(/^symphony\/ORG-repo-42-[a-f0-9]{12}$/u);
  });

  it("resolves the default branch, clones, creates a local branch, and verifies the exact SHA", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-workspace-"));
    directories.push(root);
    const canonicalRoot = await realpath(root);
    const workspace = path.join(canonicalRoot, "ORG_repo_42");
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
      cwd: canonicalRoot,
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
      cwd: canonicalRoot,
      environment: { HOME: "/home/service", PATH: "/usr/bin:/bin" },
    });
    expect(switchRequest?.environment).not.toHaveProperty("GH_TOKEN");
    expect(run.mock.calls[2]?.[0]).toMatchObject({
      arguments: ["-C", workspace, "rev-parse", "HEAD"],
      command: "git",
    });
  });

  it("populates a repair SystemJob under the isolated _system workspace root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-github-system-workspace-"));
    directories.push(root);
    const canonicalRoot = await realpath(root);
    const workspace = path.join(canonicalRoot, "_system", "repair-repair-1");
    const baseSha = "0123456789abcdef0123456789abcdef01234567";
    const run = vi.fn<WorkspaceCommandRunner["run"]>(async (request) => {
      if (request.command === "gh") {
        await mkdir(workspace, { recursive: true });
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
      environment: {},
      timeoutMs: 5_000,
    });

    await expect(
      adapter.populateSystemJobWorkspace?.({
        id: "repair-1",
        kind: "repair",
        repository: "ORG/repo",
        workspaceRoot: root,
      }),
    ).resolves.toMatchObject({
      localBranch: expect.stringMatching(/^symphony\/system-repair-/u),
      workspacePath: workspace,
    });
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        arguments: ["repo", "clone", "ORG/repo", workspace, "--", "--no-checkout"],
      }),
    );
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

  it.each([
    ["output", 1_000, 100, "workspace.command_output_limit"],
    ["timeout", 250, 10_000, "workspace.command_timeout"],
  ] as const)("terminates a real trusted workspace process tree at the %s boundary when parent-side group signaling is denied", async (mode, timeoutMs, maxOutputBytes, error) => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-workspace-process-tree-"));
    directories.push(root);
    const executable = path.join(root, "git");
    const pidFile = path.join(root, "pids");
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    let spawnedPids: number[] = [];
    try {
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync, writeSync } = require("node:fs");',
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "writeFileSync(process.env.SYMPHONY_PID_FILE, String(process.pid) + '\\n' + String(grandchild.pid) + '\\n');",
          `if (${JSON.stringify(mode)} === "output") writeSync(1, Buffer.alloc(10_000, "x"));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      await chmod(executable, 0o755);

      await expect(
        createNodeWorkspaceCommandRunner().run({
          arguments: [],
          command: "git",
          cwd: root,
          environment: {
            PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            SYMPHONY_PID_FILE: pidFile,
          },
          maxOutputBytes,
          timeoutMs,
        }),
      ).rejects.toThrow(error);
      spawnedPids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
      expect(spawnedPids).toHaveLength(2);
      expect(spawnedPids.every((pid) => !isActiveProcess(pid))).toBe(true);
    } finally {
      kill.mockRestore();
      for (const pid of spawnedPids) {
        try {
          originalKill(pid, "SIGKILL");
        } catch {}
      }
    }
  });

  it("synchronizes a clean assigned workspace to an exact published branch revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-workspace-sync-"));
    directories.push(root);
    const workspace = path.join(root, "ORG_repo_42");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
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
          canonicalWorkspace,
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
        arguments: ["-C", canonicalWorkspace, "reset", "--hard", headSha],
      }),
    );
  });
});

function isActiveProcess(pid: number): boolean {
  try {
    const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}
