import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PlanReviewResult } from "@symphony/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { finishPlanReviewAttempt } from "./plan-review-finish-store.js";

let directory: string;
let opened: OpenedDatabase;

const handoff = {
  acceptance_criteria: ["Review the Plan"],
  commands: [],
  decisions_fixed: [],
  files_changed: [],
  goal: "Review a high-risk Plan",
  open_items: [],
  revision: "abc1234",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-plan-review-finish-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("Plan-review attempt finish", () => {
  it("atomically approves the reviewed Plan and readies implementation", async () => {
    seedReviewAttempt();

    await finish(result("approve"), { maxPlanRevisions: 2 });

    expect(opened.sqlite.prepare("select status, approved_by_attempt_id from plans").get()).toEqual(
      {
        approved_by_attempt_id: "review-attempt",
        status: "approved",
      },
    );
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "implementation_after_plan_approval",
    });
    expect(opened.sqlite.prepare("select result_kind from terminal_results").get()).toEqual({
      result_kind: "plan_review_result",
    });
    expect(opened.sqlite.prepare("select consumed, reserved from budget_ledgers").all()).toEqual([
      { consumed: 40, reserved: 0 },
      { consumed: 40, reserved: 0 },
      { consumed: 40, reserved: 0 },
    ]);
  });

  it("rejects the reviewed Plan and readies a fresh Plan revision", async () => {
    seedReviewAttempt();

    await finish(result("needs_rework"), { maxPlanRevisions: 2 });

    expect(opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "rejected",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "plan_revision_required",
    });
  });

  it("parks for human review after the configured rejected-revision cap", async () => {
    seedReviewAttempt({ priorRejected: true });

    await finish(result("needs_rework", 2), { maxPlanRevisions: 2, planId: "plan-2" });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "AwaitingHuman",
      reason: "human_review",
    });
    expect(opened.sqlite.prepare("select reason from parked_work").get()).toEqual({
      reason: "human_review",
    });
  });

  it("stores the question and parks needs-input work atomically", async () => {
    seedReviewAttempt();

    await finish(result("needs_input"), {
      maxPlanRevisions: 2,
      questionId: "question-1",
    });

    expect(opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "rejected",
    });
    expect(
      opened.sqlite
        .prepare("select id, text, default_answer, comment_marker from operator_questions")
        .get(),
    ).toEqual({
      comment_marker: "<!-- symphony-question:question-1 -->",
      default_answer: "Keep scope",
      id: "question-1",
      text: "Should the scope change?",
    });
    expect(opened.sqlite.prepare("select reason, question_id from parked_work").get()).toEqual({
      question_id: "question-1",
      reason: "needs_input",
    });
    expect(opened.sqlite.prepare("select mode, reason, question_id from claims").get()).toEqual({
      mode: "AwaitingHuman",
      question_id: "question-1",
      reason: "needs_input",
    });
  });

  it("rolls back closure when the result targets another Plan revision", async () => {
    seedReviewAttempt();

    await expect(finish(result("approve", 2), { maxPlanRevisions: 2 })).rejects.toThrow(
      "plan_review.plan_revision_mismatch",
    );

    expect(opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "validated",
    });
    expect(
      opened.sqlite.prepare("select status from attempts where id = 'review-attempt'").get(),
    ).toEqual({
      status: "running",
    });
    expect(opened.sqlite.prepare("select status from budget_reservations").get()).toEqual({
      status: "reserved",
    });
  });
});

function seedReviewAttempt(input: { priorRejected?: boolean } = {}): void {
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id
      ) values (
        'builder-attempt', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG-1',
        'config-1', 'deep', 'model', 'high', '[]', 'high_risk',
        't0', 't1', 'closed', 'builder-result'
      )`,
    )
    .run();
  if (input.priorRejected) insertPlan("plan-1", 1, "rejected");
  insertPlan(input.priorRejected ? "plan-2" : "plan-1", input.priorRejected ? 2 : 1, "validated");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values (
        'review-attempt', 'issue', 'issue-1', 'plan_review', 2, '/tmp/work/ORG-1',
        'config-1', 'economy', 'model', 'low', '[]', 'high_risk', 't2', 'running'
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Running', 't2', 't2', 't3', 'In Progress', 'plan_review')`,
    )
    .run();
  for (const [id, scope, scopeId] of [
    ["attempt-ledger", "attempt", "review-attempt"],
    ["issue-ledger", "issue", "issue-1"],
    ["fleet-ledger", "rolling_24h", "fleet"],
  ] as const) {
    opened.sqlite
      .prepare(
        `insert into budget_ledgers (
          id, scope, scope_id, unit, base_limit, effective_limit, reserved, updated_at
        ) values (?, ?, ?, 'tokens', 1000, 1000, 100, 't2')`,
      )
      .run(id, scope, scopeId);
  }
  opened.sqlite
    .prepare(
      `insert into budget_reservations (
        id, work_ref_kind, work_ref_id, attempt_id, estimated_amounts_json,
        actual_amounts_json, status, created_at, updated_at
      ) values (
        'reservation-1', 'issue', 'issue-1', 'review-attempt', '{}', '{}', 'reserved', 't2', 't2'
      )`,
    )
    .run();
  for (const id of ["attempt-ledger", "issue-ledger", "fleet-ledger"]) {
    opened.sqlite
      .prepare(
        "insert into budget_reservation_ledgers (reservation_id, ledger_id, reserved_amount) values ('reservation-1', ?, 100)",
      )
      .run(id);
  }
}

function insertPlan(id: string, revision: number, status: "rejected" | "validated"): void {
  opened.sqlite
    .prepare(
      `insert into plans (
        id, work_ref_kind, work_ref_id, revision, status, approach,
        acceptance_criteria_json, proposed_paths_json, verification_commands_json,
        estimated_files, estimated_changed_lines, risk_facts_json,
        created_by_attempt_id, created_at, validated_at, approved_by_attempt_id
      ) values (?, 'issue', 'issue-1', ?, ?, 'Review it', '[]', '[]', '[]', 1, 10, '[]',
        'builder-attempt', 't1', 't1', null)`,
    )
    .run(id, revision, status);
}

function result(
  decision: "approve" | "needs_input" | "needs_rework",
  planRevision = 1,
): PlanReviewResult {
  if (decision === "approve") {
    return {
      decision,
      evidence: [{ kind: "file", path: "PLAN.md" }],
      findings: [],
      handoff,
      plan_revision: planRevision,
    };
  }
  if (decision === "needs_rework") {
    return {
      decision,
      evidence: [{ kind: "file", path: "PLAN.md" }],
      findings: [
        {
          behavior: "Missing rollback proof",
          blocking: true,
          evidence: [{ kind: "file", path: "PLAN.md" }],
          id: "finding-1",
          severity: "high",
        },
      ],
      handoff,
      plan_revision: planRevision,
    };
  }
  return {
    decision,
    evidence: [{ kind: "file", path: "PLAN.md" }],
    findings: [],
    handoff,
    plan_revision: planRevision,
    question: {
      default: "Keep scope",
      options: ["Keep scope", "Expand scope"],
      text: "Should the scope change?",
    },
  };
}

async function finish(
  reviewResult: PlanReviewResult,
  input: { maxPlanRevisions: number; planId?: string; questionId?: string },
): Promise<void> {
  await finishPlanReviewAttempt(opened.database, {
    attemptId: "review-attempt",
    costUsd: null,
    endedAt: "t4",
    maxPlanRevisions: input.maxPlanRevisions,
    planId: input.planId ?? "plan-1",
    questionId: input.questionId ?? null,
    reservationId: "reservation-1",
    result: reviewResult,
    settledLedgers: ["attempt-ledger", "issue-ledger", "fleet-ledger"].map((id) => ({
      actualAmount: 40,
      id,
    })),
    terminalResultId: "review-result",
    usage: { inputTokens: 30, outputTokens: 10 },
    workRef: { id: "issue-1", kind: "issue" },
  });
}
