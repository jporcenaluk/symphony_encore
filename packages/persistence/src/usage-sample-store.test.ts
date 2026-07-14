import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { startLiveAttemptSession } from "./live-session-store.js";
import { recordAttemptUsageSample } from "./usage-sample-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-usage-sample-"));
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
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/issue-1',
        'config-1', 'standard', 'model', 'medium', '[]', 'standard',
        '2026-07-13T10:00:00Z', 'created'
      )`,
    )
    .run();
  await startLiveAttemptSession(opened.database, {
    adapter_version: "codex-1",
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
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("durable absolute usage samples", () => {
  it("stores absolute values and derived deltas while advancing the live Attempt atomically", async () => {
    await recordAttemptUsageSample(opened.database, {
      attemptId: "attempt-1",
      billableCategories: { cached_input_tokens: 20, reasoning_output_tokens: 5 },
      costUsd: 0.25,
      id: "usage-1",
      inputTokens: 80,
      outputTokens: 20,
      serviceRunId: "run-1",
      timestamp: "2026-07-13T10:00:02Z",
      totalTokens: 100,
      turnCount: 1,
      turnId: "turn-1",
    });
    await recordAttemptUsageSample(opened.database, {
      attemptId: "attempt-1",
      billableCategories: { cached_input_tokens: 30, reasoning_output_tokens: 10 },
      costUsd: 0.5,
      id: "usage-2",
      inputTokens: 140,
      outputTokens: 60,
      serviceRunId: "run-1",
      timestamp: "2026-07-13T10:00:03Z",
      totalTokens: 200,
      turnCount: 1,
      turnId: "turn-1",
    });

    expect(
      opened.sqlite
        .prepare(
          `select id, input_tokens, output_tokens, total_tokens,
                  derived_input_tokens, derived_output_tokens, derived_total_tokens, cost_usd
           from usage_samples order by timestamp`,
        )
        .all(),
    ).toEqual([
      {
        cost_usd: 0.25,
        derived_input_tokens: 80,
        derived_output_tokens: 20,
        derived_total_tokens: 100,
        id: "usage-1",
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
      },
      {
        cost_usd: 0.5,
        derived_input_tokens: 60,
        derived_output_tokens: 40,
        derived_total_tokens: 100,
        id: "usage-2",
        input_tokens: 140,
        output_tokens: 60,
        total_tokens: 200,
      },
    ]);
    expect(
      opened.sqlite
        .prepare("select input_tokens, output_tokens, total_tokens, cost_usd from attempts")
        .get(),
    ).toEqual({ cost_usd: 0.5, input_tokens: 140, output_tokens: 60, total_tokens: 200 });
  });

  it("rejects regressing tokens or cost without writing a sample", async () => {
    await recordAttemptUsageSample(opened.database, {
      attemptId: "attempt-1",
      billableCategories: {},
      costUsd: 0.5,
      id: "usage-1",
      inputTokens: 80,
      outputTokens: 20,
      serviceRunId: "run-1",
      timestamp: "2026-07-13T10:00:02Z",
      totalTokens: 100,
      turnCount: 1,
      turnId: "turn-1",
    });
    await expect(
      recordAttemptUsageSample(opened.database, {
        attemptId: "attempt-1",
        billableCategories: {},
        costUsd: 0.4,
        id: "usage-2",
        inputTokens: 70,
        outputTokens: 20,
        serviceRunId: "run-1",
        timestamp: "2026-07-13T10:00:03Z",
        totalTokens: 90,
        turnCount: 1,
        turnId: "turn-1",
      }),
    ).rejects.toThrow("usage_sample.regression");
    expect(opened.sqlite.prepare("select count(*) as count from usage_samples").get()).toEqual({
      count: 1,
    });
  });
});
