import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import { loadPendingImplementationRetry } from "./implementation-retry-store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});

describe("implementation retry recovery", () => {
  it("recovers only a claim-matched durable factual handoff", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-implementation-retry-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    seed(opened.sqlite);

    await expect(
      loadPendingImplementationRetry(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toMatchObject({
      changeClass: "standard",
      handoff: { goal: "Resume the worker", revision: "abc1234" },
      reason: "no_progress_retry",
      routingFacts: ["risk.concurrency"],
      source: { status: "no_progress" },
      workspacePath: "/work/ORG-1",
    });

    opened.sqlite.prepare("update claims set reason = 'implementation_rework'").run();
    await expect(
      loadPendingImplementationRetry(opened.database, { id: "issue-1", kind: "issue" }),
    ).rejects.toThrow("implementation_retry.persisted_source_mismatch");
    await opened.close();
  });
});

function seed(sqlite: ReturnType<typeof openDatabase>["sqlite"]): void {
  const handoff = {
    acceptance_criteria: ["The worker resumes"],
    commands: [{ command: "make verify-fast", exit_code: 1 }],
    decisions_fixed: [],
    files_changed: ["src/worker.ts"],
    goal: "Resume the worker",
    open_items: ["Complete the worker"],
    revision: "abc1234",
  };
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/work/ORG-1',
        'config-1', 'standard', 'model', 'medium', '["risk.concurrency"]', 'standard',
        't0', 't1', 'closed', 'result-1'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into terminal_results (
        id, attempt_id, role, result_kind, payload_json, created_at
      ) values ('result-1', 'attempt-1', 'implementation', 'implementation_outcome', ?, 't1')`,
    )
    .run(
      JSON.stringify({
        actions_requested: [],
        confusions: [],
        evidence: [],
        handoff,
        status: "no_progress",
        summary: "A fresh attempt is required.",
      }),
    );
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null,
        'In Progress', 'no_progress_retry')`,
    )
    .run();
}
