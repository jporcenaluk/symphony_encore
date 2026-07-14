import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runLinuxVerification } from "./linux-verification.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe.runIf(process.platform === "linux")("independent Linux verification", () => {
  it("runs the pinned command in a non-login scrubbed sandbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-verification-"));
    directories.push(root);
    const workspace = path.join(root, "issue-1");
    const timestamps = ["2026-07-13T10:00:00Z", "2026-07-13T10:00:01Z"];

    const result = await runLinuxVerification({
      allowlistedEnvironmentNames: ["LANG", "PATH", "GITHUB_TOKEN"],
      command: [
        "if shopt -q login_shell; then exit 90; fi",
        'if test -n "$' + '{GITHUB_TOKEN+x}"; then exit 91; fi',
        'printf verified > "$HOME/result.txt"',
        'printf "verification output"',
      ].join("\n"),
      now: () => timestamps.shift() ?? "unexpected",
      sourceEnvironment: {
        GITHUB_TOKEN: "must-not-cross",
        LANG: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      timeoutMs: 5_000,
      workspace,
      workspaceRoot: root,
    });

    expect(result).toMatchObject({
      endedAt: "2026-07-13T10:00:01Z",
      exitCode: 0,
      result: "passed",
      startedAt: "2026-07-13T10:00:00Z",
      stderr: "",
      stdout: "verification output",
    });
    expect(result.commandHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.environmentPolicyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await readFile(path.join(workspace, ".home/result.txt"), "utf8")).toBe("verified");
  });

  it("classifies command failure without confusing it with runner error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-verification-"));
    directories.push(root);
    const workspace = path.join(root, "issue-1");

    const result = await runLinuxVerification({
      allowlistedEnvironmentNames: ["PATH"],
      command: "printf failure >&2; exit 7",
      now: () => "2026-07-13T10:00:00Z",
      sourceEnvironment: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      workspace,
      workspaceRoot: root,
    });

    expect(result).toMatchObject({ exitCode: 7, result: "failed", stderr: "failure" });
    await expect(access(path.join(workspace, ".home"))).resolves.toBeUndefined();
  });
});
