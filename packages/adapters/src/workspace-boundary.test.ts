import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildScrubbedWorkerEnvironment,
  isSensitiveEnvironmentName,
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
    expect(systemJobWorkspacePath("/work", "repair", "job/42")).toBe(
      path.resolve("/work/_system/repair-job_42"),
    );
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
