import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentLaunchRequest, AgentSession } from "@symphony/adapters";
import type { AgentAdapterManifest, AgentEvent } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import { applyMigrations, type OpenedDatabase, openDatabase } from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchAndBindAgentSession } from "./agent-session-binding.js";

let directory: string;
let opened: OpenedDatabase;

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-app-server-v2:test",
  capabilities: ["terminal_result", "submit_plan", "skills"],
  price_table: null,
  profiles: {
    deep: { model: "gpt-test", reasoning_effort: "high" },
    economy: { model: "gpt-test", reasoning_effort: "low" },
    standard: { model: "gpt-test", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:protocol" },
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-agent-binding-"));
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
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/issue-1',
        'config-1', 'standard', 'gpt-test', 'medium', '[]', 'standard',
        '2026-07-13T10:00:00Z', 'created'
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function request(attemptId = "attempt-1"): AgentLaunchRequest {
  return {
    attemptId,
    command: "codex app-server",
    environment: {},
    preflight: {
      adapterVersion: manifest.adapter_version,
      manifest,
      protocolSchemaHash: manifest.protocol.schema_hash,
      resolvedSkills: [],
      role: "implementation",
      submitPlanSchema: null,
      terminalResultSchema: {},
    },
    profile: "standard",
    prompt: "Implement it",
    title: "ORG/repo#1: Implement it",
    workspacePath: "/tmp/work/issue-1",
  };
}

function adapter(
  events: readonly AgentEvent[],
  cancel = vi.fn(async () => undefined),
): AgentAdapter {
  const session: AgentSession = {
    cancel,
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    processGroupId: 4320,
    processId: 4321,
    waitForExit: async () => ({ code: 0, signal: null }),
  };
  return {
    launch: vi.fn(async () => session),
    manifest: vi.fn(async () => manifest),
    preflight: vi.fn(),
  };
}

function started(attemptId = "attempt-1"): AgentEvent {
  return {
    attempt_id: attemptId,
    event: "session_started",
    model: "gpt-test",
    reasoning_effort: "medium",
    session_id: "thread-1-turn-1",
    thread_id: "thread-1",
    timestamp: "2026-07-13T10:00:03Z",
    turn_id: "turn-1",
  };
}

describe("agent session binding", () => {
  it("commits the first matching session event before exposing remaining events", async () => {
    const notification: AgentEvent = {
      attempt_id: "attempt-1",
      event: "notification",
      message: "working",
      session_id: "thread-1-turn-1",
      timestamp: "2026-07-13T10:00:04Z",
    };
    const launchRequest = request();
    const bound = await launchAndBindAgentSession({
      adapter: adapter([started(), notification]),
      database: opened.database,
      request: launchRequest,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
    });

    const remaining: AgentEvent[] = [];
    for await (const event of bound.events) remaining.push(event);
    expect(remaining).toEqual([notification]);
    expect(bound.preflight).toBe(launchRequest.preflight);
    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "running",
    });
    expect(
      opened.sqlite
        .prepare(
          `select session_id, thread_id, turn_id, process_id, process_group_id,
                  adapter_version, protocol_schema_hash, last_event
           from live_sessions`,
        )
        .get(),
    ).toEqual({
      adapter_version: manifest.adapter_version,
      last_event: "session_started",
      process_group_id: 4320,
      process_id: 4321,
      protocol_schema_hash: manifest.protocol.schema_hash,
      session_id: "thread-1-turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
  });

  it("latches and cancels the process when durable session binding fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const stopWorkers = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopWorkers);
    await expect(
      launchAndBindAgentSession({
        adapter: adapter([started("attempt-missing")], cancel),
        database: opened.database,
        request: request("attempt-missing"),
        safety,
      }),
    ).rejects.toThrow("live_session.attempt_not_created");
    expect(cancel).toHaveBeenCalledWith("persistence_failure");
    expect(stopWorkers).toHaveBeenCalledOnce();
    expect(safety.canDispatch()).toBe(false);
  });

  it("rejects startup failure without publishing a live session", async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      launchAndBindAgentSession({
        adapter: adapter(
          [
            {
              attempt_id: "attempt-1",
              error_code: "auth_failed",
              event: "startup_failed",
              session_id: null,
              timestamp: "2026-07-13T10:00:03Z",
            },
          ],
          cancel,
        ),
        database: opened.database,
        request: request(),
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      }),
    ).rejects.toThrow("agent.startup_failed:auth_failed");
    expect(cancel).toHaveBeenCalledWith("startup_failed");
    expect(opened.sqlite.prepare("select count(*) as count from live_sessions").get()).toEqual({
      count: 0,
    });
  });
});
