import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runLinuxSandboxed } from "./linux-sandbox.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe.runIf(process.platform === "linux")("Linux filesystem sandbox", () => {
  it("allows assigned-workspace writes and denies traversal and symlink escapes", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "symphony-sandbox-"));
    directories.push(parent);
    const workspace = path.join(parent, "root", "issue-1");
    const outside = path.join(parent, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    const hostSecret = path.join(outside, "host-secret.txt");
    await writeFile(hostSecret, "credential", "utf8");
    await symlink(outside, path.join(workspace, "outside-link"));

    const result = await runLinuxSandboxed({
      args: [
        "-c",
        [
          "printf inside > inside.txt",
          "if printf escaped > ../../traversal.txt; then exit 91; fi",
          "if printf escaped > outside-link/symlink.txt; then exit 92; fi",
          `if test -r ${hostSecret}; then exit 93; fi`,
          'if test -n "$' + '{GITHUB_TOKEN+x}"; then exit 94; fi',
        ].join("\n"),
      ],
      command: "/bin/bash",
      environment: { GITHUB_TOKEN: "must-not-cross", PATH: "/usr/bin:/bin" },
      workspace,
      workspaceRoot: path.join(parent, "root"),
    });

    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(await readFile(path.join(workspace, "inside.txt"), "utf8")).toBe("inside");
    await expect(access(path.join(parent, "traversal.txt"))).rejects.toThrow();
    await expect(access(path.join(outside, "symlink.txt"))).rejects.toThrow();
  });
});
