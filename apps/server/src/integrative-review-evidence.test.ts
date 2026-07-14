import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkspaceCommandRunner } from "@symphony/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectIntegrativeReviewContext } from "./integrative-review-evidence.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});

describe("integrative review evidence", () => {
  it("checks a clean immutable target and hashes the normalized full diff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-review-evidence-"));
    directories.push(root);
    const workspace = path.join(root, "ORG-21");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const diff = "diff --git a/src/worker.ts b/src/worker.ts\nnew behavior\n";
    const responses = [
      { exitCode: 0, stderr: "", stdout: "def5678\n" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "src/worker.ts\n" },
      { exitCode: 0, stderr: "", stdout: "10\t2\tsrc/worker.ts\n" },
      { exitCode: 0, stderr: "", stdout: diff },
      { exitCode: 0, stderr: "", stdout: "AGENTS.md\nREADME.md\n" },
      { exitCode: 0, stderr: "", stdout: "# Agent rules\n" },
      { exitCode: 0, stderr: "", stdout: "# Repository\n" },
    ];
    const runner: WorkspaceCommandRunner = {
      run: vi.fn(async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected command");
        return response;
      }),
    };

    const context = await collectIntegrativeReviewContext({
      baseSha: "abc1234",
      changeClass: "standard",
      commandRunner: runner,
      sourceEnvironment: { GH_TOKEN: "secret", PATH: "/usr/bin" },
      targetSha: "def5678",
      timeoutMs: 60_000,
      verificationRecordId: "verification-1",
      workspace,
      workspaceRoot: root,
    });

    expect(context).toMatchObject({
      baseSha: "abc1234",
      changeClass: "standard",
      changedFiles: ["src/worker.ts"],
      changedLines: 12,
      diff,
      repositoryDocs: [
        { content: "# Agent rules\n", path: "AGENTS.md" },
        { content: "# Repository\n", path: "README.md" },
      ],
      targetSha: "def5678",
      verificationRecordId: "verification-1",
    });
    expect(context.patchIdentity).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(runner.run).toHaveBeenCalledTimes(9);
    expect(vi.mocked(runner.run).mock.calls[0]?.[0].environment).toEqual({ PATH: "/usr/bin" });
    expect(vi.mocked(runner.run).mock.calls[5]?.[0].arguments).toEqual([
      "-C",
      canonicalWorkspace,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "abc1234",
      "def5678",
      "--",
    ]);
  });

  it("rejects a stale or dirty review target before returning evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-review-evidence-"));
    directories.push(root);
    const workspace = path.join(root, "ORG-21");
    await mkdir(workspace);
    const stale: WorkspaceCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "fffffff\n" })),
    };
    await expect(
      collectIntegrativeReviewContext({
        baseSha: "abc1234",
        changeClass: "standard",
        commandRunner: stale,
        sourceEnvironment: {},
        targetSha: "def5678",
        timeoutMs: 60_000,
        verificationRecordId: "verification-1",
        workspace,
        workspaceRoot: root,
      }),
    ).rejects.toThrow("review.target_sha_changed");
  });
});
