import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildScrubbedWorkerEnvironment,
  isSensitiveEnvironmentName,
  issueWorkspacePath,
  reconcileWorkspaceOwnership,
  removeTerminalWorkspace,
  resolveAssignedWorkspace,
  sanitizeWorkspaceIdentifier,
  systemJobWorkspacePath,
} from "./workspace-boundary.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("workspace path boundary", () => {
  it("sanitizes issue and SystemJob identifiers deterministically", () => {
    expect(sanitizeWorkspaceIdentifier("owner/repo#42: auth fix")).toBe("owner_repo_42__auth_fix");
    expect(issueWorkspacePath("/work", "owner/repo#42")).toBe(path.resolve("/work/owner_repo_42"));
    expect(systemJobWorkspacePath("/work", "repair", "job/42")).toBe(
      path.resolve("/work/_system/repair-job_42"),
    );
  });

  it("keeps claimed workspaces and quarantines unowned issue and SystemJob workspaces", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const ownedIssue = path.join(root, "issue-1");
    const staleIssue = path.join(root, "issue-2");
    const ownedJob = path.join(root, "_system", "repair-job-1");
    const staleJob = path.join(root, "_system", "synthesis-job-2");
    await Promise.all(
      [ownedIssue, staleIssue, ownedJob, staleJob].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(path.join(staleIssue, "evidence.txt"), "preserve me");

    const result = await reconcileWorkspaceOwnership({
      owned: [
        { workRef: "issue:1", workspacePath: ownedIssue },
        { workRef: "system_job:1", workspacePath: ownedJob },
      ],
      quarantineId: "startup-1",
      workspaceRoot: root,
    });

    expect(result.owned).toEqual([await resolve(ownedIssue), await resolve(ownedJob)]);
    expect(result.quarantined).toEqual([
      {
        from: path.resolve(staleIssue),
        to: path.join(root, ".quarantine", "startup-1", "issue-2"),
      },
      {
        from: path.resolve(staleJob),
        to: path.join(root, ".quarantine", "startup-1", "_system", "synthesis-job-2"),
      },
    ]);
    await expect(access(ownedIssue)).resolves.toBeUndefined();
    await expect(access(ownedJob)).resolves.toBeUndefined();
    await expect(access(staleIssue)).rejects.toThrow();
    await expect(access(staleJob)).rejects.toThrow();
    expect(await readdir(path.join(root, ".quarantine", "startup-1", "issue-2"))).toContain(
      "evidence.txt",
    );
  });

  it("rejects cross-work ownership of one canonical workspace", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const workspace = path.join(root, "issue-1");
    await mkdir(workspace, { recursive: true });

    await expect(
      reconcileWorkspaceOwnership({
        owned: [
          { workRef: "issue:1", workspacePath: workspace },
          { workRef: "issue:2", workspacePath: workspace },
        ],
        quarantineId: "startup-1",
        workspaceRoot: root,
      }),
    ).rejects.toThrow("workspace.cross_work_ownership");
    await expect(access(workspace)).resolves.toBeUndefined();
  });

  it("rejects claimed paths outside the issue and SystemJob layout before mutation", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const nested = path.join(root, "container", "issue-1");
    await mkdir(nested, { recursive: true });

    await expect(
      reconcileWorkspaceOwnership({
        owned: [{ workRef: "issue:1", workspacePath: nested }],
        quarantineId: "startup-1",
        workspaceRoot: root,
      }),
    ).rejects.toThrow("workspace.invalid_layout");
    await expect(access(nested)).resolves.toBeUndefined();
  });

  it("quarantines an unclaimed symlink alias to an owned workspace", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const workspace = path.join(root, "issue-1");
    const alias = path.join(root, "alias");
    await mkdir(workspace, { recursive: true });
    await symlink(workspace, alias);

    const result = await reconcileWorkspaceOwnership({
      owned: [{ workRef: "issue:1", workspacePath: workspace }],
      quarantineId: "startup-1",
      workspaceRoot: root,
    });

    expect(result.quarantined).toEqual([
      {
        from: alias,
        to: path.join(root, ".quarantine", "startup-1", "alias"),
      },
    ]);
    await expect(access(workspace)).resolves.toBeUndefined();
    await expect(access(alias)).rejects.toThrow();
  });

  it("accepts a real descendant and rejects a sibling-prefix path", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const assigned = path.join(root, "issue-1");
    const sibling = path.join(parent, "root-escape");
    await mkdir(assigned, { recursive: true });
    await mkdir(sibling);

    await expect(resolveAssignedWorkspace(root, assigned)).resolves.toBe(await resolve(assigned));
    await expect(resolveAssignedWorkspace(root, sibling)).rejects.toThrow("workspace.outside_root");
  });

  it("rejects a workspace symlink whose target escapes the root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "issue-1"));

    await expect(resolveAssignedWorkspace(root, path.join(root, "issue-1"))).rejects.toThrow(
      "workspace.outside_root",
    );
  });

  it("runs before_remove best effort and removes only a canonical descendant", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
    directories.push(parent);
    const root = path.join(parent, "root");
    const assigned = path.join(root, "issue-1");
    await mkdir(assigned, { recursive: true });
    await writeFile(path.join(assigned, "artifact.txt"), "terminal evidence already persisted");

    await expect(
      removeTerminalWorkspace({
        assignedWorkspace: assigned,
        beforeRemove: async () => {
          throw new Error("hook.failed");
        },
        workspaceRoot: root,
      }),
    ).resolves.toMatchObject({
      hookError: expect.objectContaining({ message: "hook.failed" }),
      removed: await resolve(assigned),
    });
    await expect(access(assigned)).rejects.toThrow();
  });
});

describe("worker environment boundary", () => {
  it.each([
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_PASSWORD",
  ])("classifies %s as a credential name", (name) => {
    expect(isSensitiveEnvironmentName(name)).toBe(true);
  });

  it("passes only allowlisted values and relocates writable process state", () => {
    const workspace = path.resolve("/work/issue-1");
    const environment = buildScrubbedWorkerEnvironment(
      workspace,
      {
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "token",
        LANG: "en_GB.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      ["LANG", "PATH", "GITHUB_TOKEN"],
    );

    expect(environment).toEqual({
      CODEX_HOME: path.join(workspace, ".codex"),
      HOME: path.join(workspace, ".home"),
      LANG: "en_GB.UTF-8",
      PATH: "/usr/bin:/bin",
      TEMP: path.join(workspace, ".tmp"),
      TMP: path.join(workspace, ".tmp"),
      TMPDIR: path.join(workspace, ".tmp"),
      XDG_CACHE_HOME: path.join(workspace, ".cache"),
      XDG_CONFIG_HOME: path.join(workspace, ".config"),
      XDG_DATA_HOME: path.join(workspace, ".local/share"),
      XDG_STATE_HOME: path.join(workspace, ".local/state"),
    });
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});

async function resolve(value: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(value);
}
