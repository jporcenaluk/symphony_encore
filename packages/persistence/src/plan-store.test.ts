import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Plan } from "@symphony/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import {
  loadAttemptPlanGateState,
  markPlanValidated,
  recordAuthoritativePlanClassification,
  recordSubmittedPlan,
} from "./plan-store.js";

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

  it("replays an exact submission after the orchestrator validates it", async () => {
    await expect(
      recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(1) }),
    ).resolves.toEqual({ replayed: false });
    await markPlanValidated(opened.database, {
      attemptId: "attempt-1",
      planId: "plan-1",
      validatedAt: "2026-07-13T10:02:00Z",
    });

    await expect(
      recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(1) }),
    ).resolves.toEqual({ replayed: true });
    expect(opened.sqlite.prepare("select status, validated_at from plans").get()).toEqual({
      status: "validated",
      validated_at: "2026-07-13T10:02:00Z",
    });
    await expect(
      recordSubmittedPlan(opened.database, {
        attemptId: "attempt-1",
        plan: { ...plan(1), approach: "Conflicting replay" },
      }),
    ).rejects.toThrow("plan.idempotency_conflict");
  });

  it("pins the first authoritative Plan class to its running attempt", async () => {
    await expect(loadAttemptPlanGateState(opened.database, "attempt-1")).resolves.toEqual({
      changeClass: "standard",
      validatedPlan: false,
    });
    await recordSubmittedPlan(opened.database, { attemptId: "attempt-1", plan: plan(1) });
    await markPlanValidated(opened.database, {
      attemptId: "attempt-1",
      planId: "plan-1",
      validatedAt: "2026-07-13T10:02:00Z",
    });

    await recordAuthoritativePlanClassification(opened.database, {
      attemptId: "attempt-1",
      changeClass: "high_risk",
      expectedProvisionalClass: "standard",
      planId: "plan-1",
      reasons: ["risk.configured_path:packages/persistence/**"],
      validatedAt: "2026-07-13T10:02:00Z",
    });

    expect(
      opened.sqlite.prepare("select change_class, routing_reasons_json from attempts").get(),
    ).toEqual({
      change_class: "high_risk",
      routing_reasons_json: '["risk.configured_path:packages/persistence/**"]',
    });
    await expect(loadAttemptPlanGateState(opened.database, "attempt-1")).resolves.toEqual({
      changeClass: "high_risk",
      validatedPlan: true,
    });
    await expect(
      recordAuthoritativePlanClassification(opened.database, {
        attemptId: "attempt-1",
        changeClass: "trivial",
        expectedProvisionalClass: "standard",
        planId: "plan-1",
        reasons: ["classification.trivial_paths"],
        validatedAt: "2026-07-13T10:02:00Z",
      }),
    ).rejects.toThrow("plan.authoritative_class_conflict");
  });
});
