import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { recordLiveSessionEvent, startLiveAttemptSession } from "./live-session-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-live-session-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/issue-1',
        'config-1', 'standard', 'model-1', 'medium', null, '[]', 'standard',
        '2026-07-13T10:00:00Z', null, 'created', null, null, 0, 0, 0, null
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const session = {
  adapter_version: "codex-1",
  attempt_id: "attempt-1",
  last_event: "session_started",
  last_event_at: "2026-07-13T10:00:02Z",
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
};

describe("live attempt sessions", () => {
  it("atomically binds process identity before marking an Attempt running", async () => {
    await expect(
      startLiveAttemptSession(opened.database, {
        ...session,
        last_input_tokens: 1,
        last_total_tokens: 0,
      }),
    ).rejects.toThrow("live_session.invalid");
    await startLiveAttemptSession(opened.database, session);

    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "running",
    });
    expect(
      opened.sqlite
        .prepare("select process_id, process_group_id, session_id from live_sessions")
        .get(),
    ).toEqual({ process_group_id: 4320, process_id: 4321, session_id: "thread-1-turn-1" });
    await expect(startLiveAttemptSession(opened.database, session)).rejects.toThrow(
      "live_session.attempt_not_created",
    );
  });

  it("atomically advances absolute usage and rejects regressing adapter events", async () => {
    await startLiveAttemptSession(opened.database, session);
    await recordLiveSessionEvent(opened.database, {
      attemptId: "attempt-1",
      event: "token_usage",
      eventAt: "2026-07-13T10:00:10Z",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      turnCount: 1,
      turnId: "turn-1",
    });

    expect(
      opened.sqlite.prepare("select input_tokens, output_tokens, total_tokens from attempts").get(),
    ).toEqual({ input_tokens: 80, output_tokens: 20, total_tokens: 100 });
    await expect(
      recordLiveSessionEvent(opened.database, {
        attemptId: "attempt-1",
        event: "stale_token_usage",
        eventAt: "2026-07-13T10:00:11Z",
        inputTokens: 70,
        outputTokens: 20,
        totalTokens: 90,
        turnCount: 1,
        turnId: "turn-1",
      }),
    ).rejects.toThrow("live_session.event_regression");
    expect(
      opened.sqlite.prepare("select last_event, last_total_tokens from live_sessions").get(),
    ).toEqual({ last_event: "token_usage", last_total_tokens: 100 });
  });
});
