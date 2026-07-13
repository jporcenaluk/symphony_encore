import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Plan } from "@symphony/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { recordSubmittedPlan } from "./plan-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-plans-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work',
        'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't0', 'running'
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function plan(revision: number): Plan {
  return {
    acceptance_criteria: [
      {
        criterion_id: "criterion-1",
        criterion_text: "The behavior works",
        planned_evidence: "pnpm test",
      },
    ],
    approach: `Approach ${revision}`,
    approved_by_attempt_id: null,
    created_at: `2026-07-13T10:0${revision}:00Z`,
    created_by_attempt_id: "attempt-1",
    estimated_changed_lines: 20,
    estimated_files: 2,
    id: `plan-${revision}`,
    proposed_paths: ["src/feature.ts"],
    revision,
    risk_facts: [],
    status: "draft",
    validated_at: null,
    verification_commands: ["pnpm test"],
    work_ref: { issue_id: "issue-1" },
  };
}

describe("submitted plan persistence", () => {
  it("stores the next revision and supersedes an earlier mutable revision", async () => {
    await recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(1) });
    await recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(2) });

    expect(
      opened.sqlite
        .prepare("select id, revision, status, approach from plans order by revision")
        .all(),
    ).toEqual([
      { approach: "Approach 1", id: "plan-1", revision: 1, status: "superseded" },
      { approach: "Approach 2", id: "plan-2", revision: 2, status: "draft" },
    ]);
  });

  it("rejects skipped revisions and attempt/work identity mismatches", async () => {
    await expect(
      recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(2) }),
    ).rejects.toThrow("plan.revision_not_next");
    await expect(
      recordSubmittedPlan(opened.database, {
        attemptId: "attempt-1",
        plan: { ...plan(1), work_ref: { issue_id: "issue-2" } },
      }),
    ).rejects.toThrow("plan.attempt_work_ref_mismatch");
  });

  it("rejects malformed and orchestrator-owned plan fields", async () => {
    await expect(
      recordSubmittedPlan(opened.database, {
        attemptId: "attempt-1",
        plan: { ...plan(1), status: "approved", approved_by_attempt_id: "attempt-1" },
      }),
    ).rejects.toThrow("plan.submission_state_invalid");
    await expect(
      recordSubmittedPlan(opened.database, {
        attemptId: "attempt-1",
        plan: { ...plan(1), verification_commands: [] },
      }),
    ).rejects.toThrow("plan.invalid");
  });
});
