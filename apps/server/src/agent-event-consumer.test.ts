import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentSession } from "@symphony/adapters";
import type { AgentAdapterManifest, AgentEvent } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  type OpenedDatabase,
  openDatabase,
  startLiveAttemptSession,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeAgentSession } from "./agent-event-consumer.js";
import type { BoundAgentSession } from "./agent-session-binding.js";

let directory: string;
let opened: OpenedDatabase;

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-1",
  capabilities: ["terminal_result"],
  price_table: null,
  profiles: {
    deep: { model: "model", reasoning_effort: "high" },
    economy: { model: "model", reasoning_effort: "low" },
    standard: { model: "model", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:protocol" },
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-agent-consumer-"));
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
    adapter_version: manifest.adapter_version,
    attempt_id: "attempt-1",
    last_event: "session_started",
    last_event_at: "2026-07-13T10:00:01Z",
    last_input_tokens: 0,
    last_output_tokens: 0,
    last_total_tokens: 0,
    ownership_verified_at: null,
    process_group_id: 4320,
    process_id: 4321,
    protocol_schema_hash: manifest.protocol.schema_hash,
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

function bound(
  events: readonly AgentEvent[],
  cancel = vi.fn(async () => undefined),
): BoundAgentSession {
  const session: AgentSession = {
    cancel,
    events: { async *[Symbol.asyncIterator]() {} },
    processGroupId: 4320,
    processId: 4321,
    waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
  };
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    session,
    started: {
      attempt_id: "attempt-1",
      event: "session_started",
      model: "model",
      reasoning_effort: "medium",
      session_id: "thread-1-turn-1",
      thread_id: "thread-1",
      timestamp: "2026-07-13T10:00:01Z",
      turn_id: "turn-1",
    },
  };
}

function tokenUsage(totalTokens = 100): AgentEvent {
  return {
    attempt_id: "attempt-1",
    billable_categories: { cached_input_tokens: 20, reasoning_output_tokens: 5 },
    cost_usd: null,
    event: "token_usage",
    input_tokens: totalTokens - 20,
    output_tokens: 20,
    session_id: "thread-1-turn-1",
    timestamp: "2026-07-13T10:00:02Z",
    total_tokens: totalTokens,
  };
}

describe("agent event consumption", () => {
  it("persists usage and terminal ordering before returning a reported result", async () => {
    const result = { status: "completed", summary: "done" };
    await expect(
      consumeAgentSession({
        attemptTokenCap: 1_000,
        bound: bound([
          tokenUsage(),
          {
            attempt_id: "attempt-1",
            event: "terminal_result_reported",
            result,
            session_id: "thread-1-turn-1",
            timestamp: "2026-07-13T10:00:03Z",
          },
          {
            attempt_id: "attempt-1",
            event: "turn_completed",
            provider_reason: "completed",
            session_id: "thread-1-turn-1",
            timestamp: "2026-07-13T10:00:04Z",
          },
        ]),
        database: opened.database,
        manifest,
        newId: () => "usage-1",
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        serviceRunId: "run-1",
        usdCap: 5,
      }),
    ).resolves.toEqual({ kind: "terminal_result", result });
    expect(opened.sqlite.prepare("select count(*) as count from usage_samples").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select last_event from live_sessions").get()).toEqual({
      last_event: "turn_completed",
    });
  });

  it("stores the cap-reaching sample and cancels before accepting further events", async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      consumeAgentSession({
        attemptTokenCap: 100,
        bound: bound([tokenUsage(100)], cancel),
        database: opened.database,
        manifest,
        newId: () => "usage-1",
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        serviceRunId: "run-1",
        usdCap: 5,
      }),
    ).resolves.toEqual({
      errorCode: "token_cap_exceeded",
      kind: "failure",
      providerReason: "attempt token cap reached",
    });
    expect(cancel).toHaveBeenCalledWith("token_cap_exceeded");
    expect(opened.sqlite.prepare("select total_tokens from attempts").get()).toEqual({
      total_tokens: 100,
    });
  });

  it("derives priced cached-input cost and enforces the USD cap", async () => {
    const cancel = vi.fn(async () => undefined);
    const pricedManifest: AgentAdapterManifest = {
      ...manifest,
      price_table: {
        models: {
          model: {
            cached_input_per_million_usd: 0.5,
            input_per_million_usd: 1,
            output_per_million_usd: 4,
          },
        },
        version: "prices-1",
      },
    };
    await expect(
      consumeAgentSession({
        attemptTokenCap: 1_000,
        bound: bound([tokenUsage()], cancel),
        database: opened.database,
        manifest: pricedManifest,
        newId: () => "usage-1",
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        serviceRunId: "run-1",
        usdCap: 0.000_15,
      }),
    ).resolves.toEqual({
      errorCode: "usd_cap_exceeded",
      kind: "failure",
      providerReason: "attempt USD cap reached",
    });
    expect(cancel).toHaveBeenCalledWith("usd_cap_exceeded");
    expect(opened.sqlite.prepare("select cost_usd from usage_samples").get()).toEqual({
      cost_usd: 0.000_15,
    });
  });

  it("latches persistence failure and cancels the bound process", async () => {
    const cancel = vi.fn(async () => undefined);
    const stopWorkers = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopWorkers);
    await expect(
      consumeAgentSession({
        attemptTokenCap: 1_000,
        bound: bound([tokenUsage()], cancel),
        database: opened.database,
        manifest,
        newId: () => "usage-1",
        safety,
        serviceRunId: "missing-run",
        usdCap: 5,
      }),
    ).rejects.toThrow();
    expect(stopWorkers).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("persistence_failure");
    expect(safety.canDispatch()).toBe(false);
  });
});
