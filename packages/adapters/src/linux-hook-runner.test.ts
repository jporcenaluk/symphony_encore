import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runLinuxHook } from "./linux-hook-runner.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe.runIf(process.platform === "linux")("Linux hook runner", () => {
  it.each([
    ["after_create", true],
    ["before_run", true],
    ["after_run", false],
    ["before_remove", false],
  ] as const)("reports %s failure with fatal=%s", async (kind, fatal) => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-hook-"));
    directories.push(root);
    const workspace = path.join(root, "issue-1");

    const result = await runLinuxHook({
      allowlistedEnvironmentNames: ["PATH"],
      command: "if shopt -q login_shell; then exit 90; fi; printf hook >&2; exit 7",
      kind,
      sourceEnvironment: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      workspace,
      workspaceRoot: root,
    });

    expect(result).toMatchObject({ exitCode: 7, fatal, status: "failed", stderr: "hook" });
  });

  it("classifies a timed-out before-run hook as a fatal runner error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-hook-"));
    directories.push(root);

    expect(
      await runLinuxHook({
        allowlistedEnvironmentNames: ["PATH"],
        command: "sleep 0.2 & wait",
        kind: "before_run",
        sourceEnvironment: { PATH: "/usr/bin:/bin" },
        timeoutMs: 10,
        workspace: path.join(root, "issue-1"),
        workspaceRoot: root,
      }),
    ).toMatchObject({ fatal: true, status: "error", stderr: "sandbox.timeout" });
  });
});
