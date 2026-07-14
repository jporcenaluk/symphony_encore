import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  createDispatch,
  type OpenedDatabase,
  openDatabase,
  recordAttemptUsageSample,
  startLiveAttemptSession,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeInitialIssueAttempt } from "./initial-issue-attempt-closure.js";

let directory: string;
let opened: OpenedDatabase;

const issue: Issue = {
  acceptance_criteria: ["The attempt closes"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Close it.",
  id: "issue-1",
  identifier: "ORG-9",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "org",
  state: "In Progress",
  title: "Close an implementation attempt",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/9",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-attempt-closure-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into service_runs (
        id, service_version, host_id, started_at, status,
        startup_config_snapshot_id, start_reason
      ) values ('run-1', '0.0.0', 'host-1', 't0', 'ready', 'config-1', 'startup')`,
    )
    .run();
  for (const [id, scope, scopeId, limit] of [
    ["attempt-ledger", "attempt", "attempt-1", 400],
    ["issue-ledger", "issue", "issue-1", 1_000],
    ["fleet-ledger", "rolling_24h", "fleet", 5_000],
  ] as const) {
    opened.sqlite
      .prepare(
        `insert into budget_ledgers (
          id, scope, scope_id, unit, base_limit, effective_limit, updated_at
        ) values (?, ?, ?, 'tokens', ?, ?, 't0')`,
      )
      .run(id, scope, scopeId, limit, limit);
  }
  await createDispatch(opened.database, {
    attempt: {
      attemptNumber: 1,
      changeClass: "standard",
      computeProfile: "standard",
      configSnapshotId: "config-1",
      costUsd: null,
      id: "attempt-1",
      model: "model",
      priceTableVersion: null,
      reasoningEffort: "medium",
      role: "implementation",
      routingReasons: ["route.implementation.standard"],
      startedAt: "2026-07-13T10:00:00Z",
      workspacePath: "/tmp/work/issue-1",
    },
    claim: {
      acquiredAt: "2026-07-13T10:00:00Z",
      expiresAt: "2026-07-13T10:02:00Z",
      holder: "run-1",
      originStage: "Todo",
      reason: "dispatch.eligible",
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
  await startLiveAttemptSession(opened.database, {
    adapter_version: "adapter-1",
    attempt_id: "attempt-1",
    last_event: "session_started",
    last_event_at: "2026-07-13T10:00:01Z",
    last_input_tokens: 0,
    last_output_tokens: 0,
    last_total_tokens: 0,
    ownership_verified_at: null,
    process_group_id: 4320,
    process_id: 4321,
    protocol_schema_hash: "sha256:protocol",
    session_id: "thread-1-turn-1",
    thread_id: "thread-1",
    turn_count: 1,
    turn_id: "turn-1",
  });
  await recordAttemptUsageSample(opened.database, {
    attemptId: "attempt-1",
    billableCategories: {},
    costUsd: null,
    id: "usage-1",
    inputTokens: 70,
    outputTokens: 30,
    serviceRunId: "run-1",
    timestamp: "2026-07-13T10:00:02Z",
    totalTokens: 100,
    turnCount: 1,
    turnId: "turn-1",
  });
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const handoff = {
  acceptance_criteria: ["The attempt closes"],
  commands: [{ command: "pnpm test", exit_code: 1 }],
  decisions_fixed: [],
  files_changed: ["src/feature.ts"],
  goal: "Close an implementation attempt",
  open_items: ["Fix the test"],
  revision: "abc1234",
};

describe("initial issue attempt closure", () => {
  it("stores a valid role result and settles actual usage", async () => {
    await closeInitialIssueAttempt({
      attemptId: "attempt-1",
      consumption: {
        kind: "terminal_result",
        result: {
          actions_requested: [],
          confusions: [],
          evidence: [],
          handoff,
          status: "needs_rework",
          summary: "A test still fails.",
        },
      },
      database: opened.database,
      endedAt: "2026-07-13T10:01:00Z",
      issue,
      maxFailureRetries: 2,
      maxRetryBackoffMs: 300_000,
      maxReworkCycles: 2,
      newId: () => "result-1",
      providerRevision: "revision-8",
      reservationId: "reservation-1",
      retryJitterSample: 0.5,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    expect(opened.sqlite.prepare("select status, terminal_result_id from attempts").get()).toEqual({
      status: "closed",
      terminal_result_id: "result-1",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "implementation_rework",
    });
    expect(opened.sqlite.prepare("select consumed, reserved from budget_ledgers").all()).toEqual([
      { consumed: 100, reserved: 0 },
      { consumed: 100, reserved: 0 },
      { consumed: 100, reserved: 0 },
    ]);
  });

  it("authors a budget failure and parks the claim after a hard cap", async () => {
    await closeInitialIssueAttempt({
      attemptId: "attempt-1",
      consumption: {
        errorCode: "token_cap_exceeded",
        kind: "failure",
        providerReason: "attempt token cap reached",
      },
      database: opened.database,
      endedAt: "2026-07-13T10:01:00Z",
      issue,
      maxFailureRetries: 2,
      maxRetryBackoffMs: 300_000,
      maxReworkCycles: 2,
      newId: () => "result-1",
      providerRevision: "revision-8",
      reservationId: "reservation-1",
      retryJitterSample: 0.5,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    expect(opened.sqlite.prepare("select failure_class from attempts").get()).toEqual({
      failure_class: "agent_process",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "AwaitingHuman",
      reason: "budget_exhausted",
    });
    const payload = opened.sqlite.prepare("select payload_json from terminal_results").get() as {
      payload_json: string;
    };
    expect(JSON.parse(payload.payload_json)).toMatchObject({
      failure_class: "agent_process",
      status: "budget_exhausted",
    });
  });

  it("queues infrastructure failures with a durable jittered backoff", async () => {
    await closeInitialIssueAttempt({
      attemptId: "attempt-1",
      consumption: {
        errorCode: "overloaded",
        kind: "failure",
        providerReason: "provider capacity exhausted",
      },
      database: opened.database,
      endedAt: "2026-07-13T10:01:00Z",
      issue,
      maxFailureRetries: 2,
      maxRetryBackoffMs: 300_000,
      maxReworkCycles: 2,
      newId: () => "result-1",
      providerRevision: "revision-8",
      reservationId: "reservation-1",
      retryJitterSample: 0.5,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    expect(opened.sqlite.prepare("select mode, reason, retry_due_at from claims").get()).toEqual({
      mode: "RetryQueued",
      reason: "overloaded",
      retry_due_at: "2026-07-13T10:01:10.000Z",
    });
    expect(
      opened.sqlite
        .prepare("select failure_class, retry_number, due_at, last_error from retry_entries")
        .get(),
    ).toEqual({
      due_at: "2026-07-13T10:01:10.000Z",
      failure_class: "infrastructure",
      last_error: "provider capacity exhausted",
      retry_number: 1,
    });
  });

  it("parks a second no-progress outcome instead of retrying indefinitely", async () => {
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
          change_class, started_at, ended_at, status, terminal_result_id
        ) values (
          'attempt-prior', 'issue', 'issue-1', 'implementation', 2, '/tmp/work/issue-1',
          'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't0', 't1', 'closed',
          'result-prior'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into terminal_results (
          id, attempt_id, role, result_kind, payload_json, created_at
        ) values ('result-prior', 'attempt-prior', 'implementation',
          'implementation_outcome', ?, 't1')`,
      )
      .run(
        JSON.stringify({
          actions_requested: [],
          confusions: [],
          evidence: [],
          handoff,
          status: "no_progress",
          summary: "The first fresh attempt made no progress.",
        }),
      );

    await closeInitialIssueAttempt({
      attemptId: "attempt-1",
      consumption: {
        kind: "terminal_result",
        result: {
          actions_requested: [],
          confusions: [],
          evidence: [],
          handoff,
          status: "no_progress",
          summary: "A second fresh attempt also made no progress.",
        },
      },
      database: opened.database,
      endedAt: "2026-07-13T10:01:00Z",
      issue,
      maxFailureRetries: 2,
      maxRetryBackoffMs: 300_000,
      maxReworkCycles: 2,
      newId: () => "result-1",
      providerRevision: "revision-8",
      reservationId: "reservation-1",
      retryJitterSample: 0.5,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "AwaitingHuman",
      reason: "no_progress",
    });
    expect(opened.sqlite.prepare("select origin_stage, reason from parked_work").get()).toEqual({
      origin_stage: "In Progress",
      reason: "no_progress",
    });
  });

  it("rejects completed outcomes without passing agent verification", async () => {
    await closeInitialIssueAttempt({
      attemptId: "attempt-1",
      consumption: {
        kind: "terminal_result",
        result: {
          actions_requested: [],
          confusions: [],
          evidence: [],
          handoff,
          status: "completed",
          summary: "The agent-side check failed.",
          verification: { command: "pnpm test", exit_code: 1, result: "failed" },
        },
      },
      database: opened.database,
      endedAt: "2026-07-13T10:01:00Z",
      issue,
      maxFailureRetries: 2,
      maxRetryBackoffMs: 300_000,
      maxReworkCycles: 2,
      newId: () => "result-1",
      providerRevision: "revision-8",
      reservationId: "reservation-1",
      retryJitterSample: 0.5,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "RetryQueued",
      reason: "result_invalid",
    });
    expect(
      opened.sqlite.prepare("select failure_class, retry_number from retry_entries").get(),
    ).toEqual({ failure_class: "agent_process", retry_number: 1 });
    const payload = opened.sqlite.prepare("select payload_json from terminal_results").get() as {
      payload_json: string;
    };
    expect(JSON.parse(payload.payload_json)).toMatchObject({
      role: "implementation",
      status: "failed",
    });
  });
});
