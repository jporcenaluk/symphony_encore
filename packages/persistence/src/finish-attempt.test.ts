import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";
import {
  finishAttempt,
  loadAttemptSettlementState,
  loadFailureRetryState,
} from "./finish-attempt.js";
import { openBaselineStage } from "./stage-transition.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-finish-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "now", "hash", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  const insertLedger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLedger.run("attempt-ledger", "attempt", "attempt-1", "tokens", 400, 400, "now");
  insertLedger.run("issue-ledger", "issue", "issue-1", "tokens", 1000, 1000, "now");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet", "tokens", 5000, 5000, "now");
  await createDispatch(opened.database, {
    attempt: {
      attemptNumber: 1,
      changeClass: "standard",
      computeProfile: "standard",
      configSnapshotId: "config-1",
      costUsd: null,
      id: "attempt-1",
      model: "provider-model",
      priceTableVersion: null,
      reasoningEffort: "medium",
      role: "implementation",
      routingReasons: ["classification.standard"],
      startedAt: "2026-07-13T10:00:00Z",
      workspacePath: "/tmp/work/issue-1",
    },
    claim: {
      acquiredAt: "2026-07-13T10:00:00Z",
      expiresAt: "2026-07-13T10:02:00Z",
      holder: "service-1",
      originStage: "Todo",
      reason: "dispatch",
    },
    reservation: {
      id: "reservation-1",
      ledgers: [
        { amount: 200, id: "attempt-ledger", version: 1 },
        { amount: 200, id: "issue-ledger", version: 1 },
        { amount: 200, id: "fleet-ledger", version: 1 },
      ],
    },
    workRef: { id: "issue-1", kind: "issue" },
  });
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const finish = {
  attemptId: "attempt-1",
  costUsd: null,
  endedAt: "2026-07-13T10:01:00Z",
  failureClass: null,
  nextClaim: { mode: "Ready" as const, reason: "review_ready" },
  reservationId: "reservation-1",
  settledLedgers: [
    { actualAmount: 150, id: "attempt-ledger" },
    { actualAmount: 150, id: "issue-ledger" },
    { actualAmount: 150, id: "fleet-ledger" },
  ],
  terminalResult: {
    id: "result-1",
    kind: "implementation_outcome",
    payload: { status: "completed" },
    role: "implementation",
  },
  usage: { inputTokens: 100, outputTokens: 50 },
  workRef: { id: "issue-1", kind: "issue" as const },
};

function finishAttemptRecord() {
  return {
    attemptNumber: 1,
    changeClass: "standard" as const,
    computeProfile: "standard" as const,
    configSnapshotId: "config-1",
    costUsd: null,
    id: "attempt-repair",
    model: "provider-model",
    priceTableVersion: null,
    reasoningEffort: "medium",
    role: "implementation" as const,
    routingReasons: ["classification.repair_floor"],
    startedAt: "2026-07-13T10:00:00Z",
    workspacePath: "/tmp/work/_system/repair-repair-1",
  };
}

describe("attempt closure transaction", () => {
  it("atomically aggregates SystemJob usage and advances its durable stage", async () => {
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, parent_work_ref_kind, parent_work_ref_id, repository, workspace_path,
          goal, acceptance_criteria_json, config_snapshot_id, status, created_at
        ) values ('repair-1', 'repair', 'issue', 'issue-1', 'owner/repo',
          '/tmp/work/_system/repair-repair-1', 'repair', '["restore"]', 'config-1',
          'queued', '2026-07-13T09:59:00Z')`,
      )
      .run();
    await openBaselineStage(opened.database, {
      enteredAt: "2026-07-13T09:59:00Z",
      id: "stage-repair-queued",
      reason: "repair_created",
      timestampSource: "observed_estimate",
      toStage: "queued",
      workRef: { id: "repair-1", kind: "system_job" },
    });
    const insertLedger = opened.sqlite.prepare(`
      insert into budget_ledgers (
        id, scope, scope_id, unit, base_limit, effective_limit, updated_at
      ) values (?, ?, ?, 'tokens', 1000, 1000, 'now')
    `);
    insertLedger.run("attempt-repair-ledger", "attempt", "attempt-repair");
    insertLedger.run("system-job-ledger", "system_job", "repair-1");
    await createDispatch(opened.database, {
      attempt: {
        ...finishAttemptRecord(),
        id: "attempt-repair",
        workspacePath: "/tmp/work/_system/repair-repair-1",
      },
      claim: {
        acquiredAt: "2026-07-13T10:00:00Z",
        expiresAt: "2026-07-13T10:02:00Z",
        holder: "service-1",
        originStage: "queued",
        reason: "system_job_dispatch",
      },
      reservation: {
        id: "reservation-repair",
        ledgers: [
          { amount: 100, id: "attempt-repair-ledger", version: 1 },
          { amount: 100, id: "system-job-ledger", version: 1 },
          { amount: 100, id: "fleet-ledger", version: 2 },
        ],
      },
      systemJobTransition: {
        attemptId: "attempt-repair",
        confirmedExternalRevision: null,
        enteredAt: "2026-07-13T10:00:00Z",
        expectedFromStage: "queued",
        id: "stage-repair-running",
        reason: "system_job_dispatch",
        timestampSource: "observed_estimate",
        toStage: "running",
        workRef: { id: "repair-1", kind: "system_job" },
      },
      workRef: { id: "repair-1", kind: "system_job" },
    });

    await finishAttempt(opened.database, {
      attemptId: "attempt-repair",
      costUsd: null,
      endedAt: "2026-07-13T10:01:00Z",
      failureClass: null,
      nextClaim: { mode: "Ready", reason: "independent_verification_required" },
      reservationId: "reservation-repair",
      settledLedgers: [
        { actualAmount: 75, id: "attempt-repair-ledger" },
        { actualAmount: 75, id: "fleet-ledger" },
        { actualAmount: 75, id: "system-job-ledger" },
      ],
      systemJobStageTransition: {
        attemptId: "attempt-repair",
        confirmedExternalRevision: null,
        enteredAt: "2026-07-13T10:01:00Z",
        expectedFromStage: "running",
        id: "stage-repair-review",
        reason: "implementation.completed",
        timestampSource: "observed_estimate",
        toStage: "review",
        workRef: { id: "repair-1", kind: "system_job" },
      },
      terminalResult: {
        id: "result-repair",
        kind: "implementation_outcome",
        payload: { status: "completed" },
        role: "implementation",
      },
      usage: { inputTokens: 50, outputTokens: 25 },
      workRef: { id: "repair-1", kind: "system_job" },
    });

    expect(
      opened.sqlite
        .prepare(
          "select status, input_tokens, output_tokens from system_jobs where id = 'repair-1'",
        )
        .get(),
    ).toEqual({ input_tokens: 50, output_tokens: 25, status: "review" });
    expect(
      opened.sqlite
        .prepare(
          "select from_stage, to_stage from stage_transitions where id = 'stage-repair-review'",
        )
        .get(),
    ).toEqual({ from_stage: "running", to_stage: "review" });
  });

  it("loads the exact open usage and reservation units needed for closure", async () => {
    await expect(
      loadAttemptSettlementState(opened.database, {
        attemptId: "attempt-1",
        reservationId: "reservation-1",
      }),
    ).resolves.toEqual({
      costUsd: null,
      inputTokens: 0,
      ledgers: [
        { id: "attempt-ledger", unit: "tokens" },
        { id: "fleet-ledger", unit: "tokens" },
        { id: "issue-ledger", unit: "tokens" },
      ],
      outputTokens: 0,
    });
  });

  it("atomically closes the attempt, settles budgets, and keeps a Ready claim", async () => {
    await finishAttempt(opened.database, finish);

    expect(
      opened.sqlite
        .prepare(
          "select status, ended_at, terminal_result_id, input_tokens, output_tokens, total_tokens from attempts",
        )
        .get(),
    ).toEqual({
      ended_at: "2026-07-13T10:01:00Z",
      input_tokens: 100,
      output_tokens: 50,
      status: "closed",
      terminal_result_id: "result-1",
      total_tokens: 150,
    });
    expect(opened.sqlite.prepare("select mode, expires_at from claims").get()).toEqual({
      expires_at: null,
      mode: "Ready",
    });
    expect(
      opened.sqlite.prepare("select id, reserved, consumed from budget_ledgers order by id").all(),
    ).toEqual([
      { consumed: 150, id: "attempt-ledger", reserved: 0 },
      { consumed: 150, id: "fleet-ledger", reserved: 0 },
      { consumed: 150, id: "issue-ledger", reserved: 0 },
    ]);
  });

  it("commits a RetryEntry with its RetryQueued claim", async () => {
    await finishAttempt(opened.database, {
      ...finish,
      failureClass: "agent_process",
      nextClaim: {
        dueAt: "2026-07-13T10:01:00Z",
        mode: "RetryQueued",
        reason: "process_exit",
      },
      retryEntry: {
        dueAt: "2026-07-13T10:01:00Z",
        failureClass: "agent_process",
        lastError: "worker exited",
        maxRetries: 2,
        retryNumber: 1,
      },
    });

    expect(opened.sqlite.prepare("select mode, retry_due_at from claims").get()).toEqual({
      mode: "RetryQueued",
      retry_due_at: "2026-07-13T10:01:00Z",
    });
    expect(
      opened.sqlite
        .prepare(
          "select attempt_id, failure_class, retry_number, due_at, max_retries, last_error from retry_entries",
        )
        .get(),
    ).toEqual({
      attempt_id: "attempt-1",
      due_at: "2026-07-13T10:01:00Z",
      failure_class: "agent_process",
      last_error: "worker exited",
      max_retries: 2,
      retry_number: 1,
    });
    await expect(
      loadFailureRetryState(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      agentProcessFailures: 1,
      firstInfrastructureFailureAt: null,
      infrastructureFailures: 0,
      retryEntries: 1,
    });
  });

  it("rejects duplicate closure without changing the committed terminal result", async () => {
    await finishAttempt(opened.database, finish);

    await expect(
      finishAttempt(opened.database, {
        ...finish,
        terminalResult: { ...finish.terminalResult, id: "result-2" },
      }),
    ).rejects.toThrow("Attempt attempt-1 is already closed or missing");
    expect(opened.sqlite.prepare("select id from terminal_results").all()).toEqual([
      { id: "result-1" },
    ]);
  });

  it("releases terminal work by deleting its active claim in the closure transaction", async () => {
    await finishAttempt(opened.database, {
      ...finish,
      nextClaim: { mode: "Released", reason: "tracker_terminal" },
    });

    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "closed",
    });
  });
});
