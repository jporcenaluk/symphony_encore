import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SynthesisResult } from "@symphony/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";
import { openBaselineStage } from "./stage-transition.js";
import { finishSynthesisAttempt } from "./synthesis-finish-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-finish-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into system_jobs (
        id, kind, repository, workspace_path, goal, acceptance_criteria_json,
        config_snapshot_id, status, created_at
      ) values ('synthesis-1', 'synthesis', 'owner/repo',
        '/tmp/work/_system/synthesis-synthesis-1', 'synthesize', '["cite lessons"]',
        'config-1', 'queued', '2026-07-13T10:00:00Z')`,
    )
    .run();
  await openBaselineStage(opened.database, {
    enteredAt: "2026-07-13T10:00:00Z",
    id: "stage-queued",
    reason: "learning.synthesis_interval",
    timestampSource: "observed_estimate",
    toStage: "queued",
    workRef: { id: "synthesis-1", kind: "system_job" },
  });
  const insertLedger = opened.sqlite.prepare(
    `insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, 'tokens', 1000, 1000, 't0')`,
  );
  insertLedger.run("attempt-ledger", "attempt", "attempt-1");
  insertLedger.run("job-ledger", "system_job", "synthesis-1");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet");
  await createDispatch(opened.database, {
    attempt: {
      attemptNumber: 1,
      changeClass: "standard",
      computeProfile: "deep",
      configSnapshotId: "config-1",
      costUsd: null,
      id: "attempt-1",
      model: "gpt-test",
      priceTableVersion: null,
      reasoningEffort: "high",
      role: "synthesis",
      routingReasons: ["learning.synthesis"],
      startedAt: "2026-07-13T10:01:00Z",
      workspacePath: "/tmp/work/_system/synthesis-synthesis-1",
    },
    claim: {
      acquiredAt: "2026-07-13T10:01:00Z",
      expiresAt: "2026-07-13T10:03:00Z",
      holder: "run-1",
      originStage: "queued",
      reason: "synthesis_dispatch",
    },
    reservation: {
      id: "reservation-1",
      ledgers: [
        { amount: 100, id: "attempt-ledger", version: 1 },
        { amount: 100, id: "job-ledger", version: 1 },
        { amount: 100, id: "fleet-ledger", version: 1 },
      ],
    },
    systemJobTransition: {
      attemptId: "attempt-1",
      confirmedExternalRevision: null,
      enteredAt: "2026-07-13T10:01:00Z",
      expectedFromStage: "queued",
      id: "stage-running",
      reason: "learning.synthesis",
      timestampSource: "observed_estimate",
      toStage: "running",
      workRef: { id: "synthesis-1", kind: "system_job" },
    },
    workRef: { id: "synthesis-1", kind: "system_job" },
  });
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("synthesis attempt closure", () => {
  it("atomically closes an evidence-backed no-change result", async () => {
    await finishSynthesisAttempt(opened.database, finishInput(noChange()));
    expect(opened.sqlite.prepare("select status, final_result_id from system_jobs").get()).toEqual({
      final_result_id: "result-1",
      status: "done",
    });
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
  });

  it("parks a needs-input result with its structured question", async () => {
    await finishSynthesisAttempt(opened.database, {
      ...finishInput({
        ...noChange(),
        decision: "needs_input",
        question: { default: "Keep", options: ["Keep", "Remove"], text: "Resolve rule conflict" },
      }),
      questionId: "question-1",
    });
    expect(opened.sqlite.prepare("select status from system_jobs").get()).toEqual({
      status: "human",
    });
    expect(opened.sqlite.prepare("select mode, reason, question_id from claims").get()).toEqual({
      mode: "AwaitingHuman",
      question_id: "question-1",
      reason: "needs_input",
    });
  });

  it("routes a proposal to independent verification", async () => {
    await finishSynthesisAttempt(
      opened.database,
      finishInput({
        ...noChange(),
        branch: "symphony/system-synthesis-1",
        decision: "propose_changes",
        pull_request: { base_ref: "main", title: "Improve workflow rules" },
        repository_revision: "abc1234",
        rule_changes: [
          {
            action: "add",
            lesson_ids: ["lesson-1"],
            rationale: "Prevent recurrence",
            rule_id: "rule-new",
            text: "Require current-head checks",
          },
        ],
      }),
    );
    expect(opened.sqlite.prepare("select status from system_jobs").get()).toEqual({
      status: "review",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "synthesis_verification_required",
    });
  });
});

function finishInput(result: SynthesisResult) {
  return {
    attemptId: "attempt-1",
    costUsd: null,
    endedAt: "2026-07-13T10:02:00Z",
    questionId: null,
    reservationId: "reservation-1",
    result,
    settledLedgers: [
      { actualAmount: 75, id: "attempt-ledger" },
      { actualAmount: 75, id: "job-ledger" },
      { actualAmount: 75, id: "fleet-ledger" },
    ],
    stageTransitionId: "stage-terminal",
    terminalResultId: "result-1",
    usage: { inputTokens: 50, outputTokens: 25 },
    workRef: { id: "synthesis-1", kind: "system_job" as const },
  };
}

function noChange(): SynthesisResult {
  return {
    cited_lesson_ids: [],
    decision: "no_change",
    evidence: [{ kind: "commit", sha: "abc1234" }],
    handoff: {
      acceptance_criteria: ["cite lessons"],
      commands: [],
      decisions_fixed: [],
      files_changed: [],
      goal: "synthesize",
      open_items: [],
      revision: "abc1234",
    },
    rule_changes: [],
  };
}
