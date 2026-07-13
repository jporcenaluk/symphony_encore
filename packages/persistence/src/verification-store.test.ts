import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import {
  findPassingVerification,
  loadVerificationEvidence,
  recordVerification,
} from "./verification-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(filename: string) {
  const opened = openDatabase(filename);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status,
        input_tokens, output_tokens, total_tokens
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "attempt-1",
      "issue",
      "issue-1",
      "implementation",
      1,
      "/work/issue-1",
      "config-1",
      "standard",
      "model",
      "medium",
      "[]",
      "standard",
      "t0",
      "running",
      0,
      0,
      0,
    );
  return opened;
}

const input = {
  attemptId: "attempt-1",
  configSnapshotId: "config-1",
  execution: {
    commandHash: "sha256:command",
    endedAt: "2026-07-13T10:00:01Z",
    environmentPolicyHash: "sha256:environment",
    exitCode: 0,
    result: "passed" as const,
    startedAt: "2026-07-13T10:00:00Z",
    stderr: "",
    stdout: "all checks passed",
  },
  id: "verification-1",
  targetRevision: "target-sha",
  workRef: { id: "issue-1", kind: "issue" as const },
};

describe("independent verification repository", () => {
  it("persists content-addressed evidence and exact guard lookup across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-verification-store-"));
    directories.push(directory);
    const filename = path.join(directory, "symphony.sqlite3");
    const first = await fixture(filename);
    const recorded = await recordVerification(first.database, input);
    expect(recorded.stdoutRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(recorded.stderrRef).toBeNull();
    if (recorded.stdoutRef === null) throw new Error("expected stdout evidence");
    await first.close();

    const restarted = openDatabase(filename);
    const passing = await findPassingVerification(restarted.database, {
      commandHash: "sha256:command",
      configSnapshotId: "config-1",
      environmentPolicyHash: "sha256:environment",
      targetRevision: "target-sha",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(passing).toMatchObject({ id: "verification-1", result: "passed" });
    expect(await loadVerificationEvidence(restarted.database, recorded.stdoutRef)).toEqual({
      content: "all checks passed",
      mediaType: "text/plain; charset=utf-8",
    });
    expect(
      await findPassingVerification(restarted.database, {
        commandHash: "sha256:different",
        configSnapshotId: "config-1",
        environmentPolicyHash: "sha256:environment",
        targetRevision: "target-sha",
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).toBeUndefined();
    await restarted.close();
  });

  it("rejects oversized evidence without committing a partial record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-verification-store-"));
    directories.push(directory);
    const opened = await fixture(path.join(directory, "symphony.sqlite3"));

    await expect(
      recordVerification(opened.database, {
        ...input,
        execution: { ...input.execution, stdout: "x".repeat(1_048_577) },
      }),
    ).rejects.toThrow("verification.evidence_too_large");
    expect(
      opened.sqlite.prepare("select count(*) as count from verification_records").get(),
    ).toEqual({ count: 0 });
    expect(opened.sqlite.prepare("select count(*) as count from evidence_blobs").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });
});
