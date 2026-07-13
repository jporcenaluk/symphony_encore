import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  loadPendingIndependentVerification,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPendingIndependentVerification } from "./independent-verification-runner.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("pending independent verification", () => {
  it.each([
    { expectedReason: "pull_request_required", result: "passed" as const },
    { expectedReason: "verification_rework", result: "failed" as const },
  ])("records and routes a $result sandbox result", async ({ expectedReason, result }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-independent-verification-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    seedPendingVerification(opened.sqlite);
    const target = await loadPendingIndependentVerification(opened.database, {
      id: "issue-1",
      kind: "issue",
    });
    if (!target) throw new Error("expected pending verification target");
    const execution = vi.fn(async () => ({
      commandHash: "sha256:command",
      endedAt: "2026-07-13T10:02:00Z",
      environmentPolicyHash: "sha256:environment",
      exitCode: result === "passed" ? 0 : 1,
      result,
      startedAt: "2026-07-13T10:01:00Z",
      stderr: result === "passed" ? "" : "test failed",
      stdout: result === "passed" ? "all passed" : "",
    }));
    const revision = vi.fn(async () => "def5678");

    const completed = await runPendingIndependentVerification({
      allowlistedEnvironmentNames: [],
      command: "make verify-fast",
      database: opened.database,
      execute: execution,
      newId: () => "verification-1",
      readRevision: revision,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      sourceEnvironment: { GH_TOKEN: "must-not-reach-verifier" },
      target,
      timeoutMs: 60_000,
      workRef: { id: "issue-1", kind: "issue" },
      workspaceRoot: directory,
    });

    expect(revision).toHaveBeenCalledWith({
      sourceEnvironment: { GH_TOKEN: "must-not-reach-verifier" },
      timeoutMs: 60_000,
      workspace: "/work/issue-1",
      workspaceRoot: directory,
    });
    expect(execution).toHaveBeenCalledWith({
      allowlistedEnvironmentNames: [],
      command: "make verify-fast",
      sourceEnvironment: { GH_TOKEN: "must-not-reach-verifier" },
      timeoutMs: 60_000,
      workspace: "/work/issue-1",
      workspaceRoot: directory,
    });
    expect(completed).toMatchObject({ result, targetRevision: "def5678" });
    expect(
      opened.sqlite.prepare("select target_revision, result from verification_records").get(),
    ).toEqual({
      result,
      target_revision: "def5678",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: expectedReason,
    });
    await opened.close();
  });
});

function seedPendingVerification(sqlite: OpenedDatabase["sqlite"]): void {
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/work/issue-1',
        'config-1', 'standard', 'model', 'medium', '[]', 'standard',
        't0', 't1', 'closed', 'result-1'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into terminal_results (id, attempt_id, role, result_kind, payload_json, created_at)
       values ('result-1', 'attempt-1', 'implementation', 'implementation_outcome', ?, 't1')`,
    )
    .run(
      JSON.stringify({
        actions_requested: [],
        confusions: [],
        evidence: [
          { command: "make verify-fast", exit_code: 0, kind: "command", result: "passed" },
        ],
        handoff: {
          acceptance_criteria: ["Verification passes"],
          commands: [{ command: "make verify-fast", exit_code: 0 }],
          decisions_fixed: [],
          files_changed: ["src/feature.ts"],
          goal: "Verify independently",
          open_items: [],
          revision: "abc1234",
        },
        status: "completed",
        summary: "Implementation is ready for verification.",
        verification: { command: "make verify-fast", exit_code: 0, result: "passed" },
      }),
    );
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null,
        'In Progress', 'independent_verification_required'
      )`,
    )
    .run();
}
