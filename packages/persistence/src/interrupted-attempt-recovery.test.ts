import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";
import {
  listInterruptedAttempts,
  loadLatestHandoffForAttempt,
  recoverInterruptedAttempt,
} from "./interrupted-attempt-recovery.js";
import { closeRunningAttemptForReconciliation } from "./scheduler-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-interrupted-attempt-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  const ledger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  ledger.run("attempt-ledger", "attempt", "attempt-1", "tokens", 400, 400, "t0");
  ledger.run("issue-ledger", "issue", "issue-1", "tokens", 1000, 1000, "t0");
  ledger.run("fleet-ledger", "rolling_24h", "fleet", "tokens", 5000, 5000, "t0");
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
      holder: "run-1",
      originStage: "In Progress",
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
  opened.sqlite
    .prepare(
      `update attempts set status = 'running', input_tokens = 100,
       output_tokens = 20, total_tokens = 120 where id = 'attempt-1'`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into live_sessions (
        attempt_id, session_id, thread_id, turn_id, process_id, process_group_id,
        adapter_version, protocol_schema_hash, last_event, last_event_at,
        turn_count, last_input_tokens, last_output_tokens, last_total_tokens
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "attempt-1",
      "session-1",
      "thread-1",
      "turn-1",
      1234,
      1230,
      "adapter-1",
      "schema-1",
      "token_usage",
      "2026-07-13T10:00:30Z",
      1,
      100,
      20,
      120,
    );
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const handoff = {
  acceptance_criteria: ["The work remains recoverable"],
  commands: [],
  decisions_fixed: [],
  files_changed: ["src/index.ts"],
  goal: "Finish the interrupted implementation",
  open_items: ["Resume from the durable workspace"],
  revision: "base-sha",
};

describe("interrupted attempt recovery", () => {
  it("builds a factual first-attempt handoff from the durable issue snapshot", async () => {
    opened.sqlite
      .prepare(
        `insert into issues (
          id, identifier, title, description, acceptance_criteria_json, state,
          labels_json, priority, blocked_by_json, assignee_id, repo_owner,
          repo_name, url, provider_revision, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "issue-1",
        "jporc/repo#1",
        "Recover the interrupted work",
        "Durable issue body",
        JSON.stringify(["State remains recoverable"]),
        "In Progress",
        "[]",
        null,
        "[]",
        "agent-1",
        "jporc",
        "repo",
        "https://github.example/issues/1",
        "tracker-revision-4",
        "2026-07-13T09:00:00Z",
        "2026-07-13T10:00:00Z",
      );

    await expect(loadLatestHandoffForAttempt(opened.database, "attempt-1")).resolves.toEqual({
      acceptance_criteria: ["State remains recoverable"],
      commands: [],
      decisions_fixed: [],
      files_changed: [],
      goal: "Recover the interrupted work",
      open_items: ["Resume work from the durable workspace after process interruption"],
      revision: "tracker-revision-4",
    });
  });

  it("prefers the latest valid durable handoff from a prior attempt", async () => {
    await recoverInterruptedAttempt(opened.database, {
      attemptId: "attempt-1",
      endedAt: "2026-07-13T10:03:00Z",
      latestHandoff: handoff,
      ownership: {
        kind: "terminated",
        processGroupId: 1230,
        processId: 1234,
        verifiedAt: "2026-07-13T10:02:59Z",
      },
      terminalResultId: "result-interrupted-1",
    });
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
          routing_reasons_json, change_class, started_at, ended_at, status,
          terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
        ) select
          'attempt-2', work_ref_kind, work_ref_id, role, 2, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
          routing_reasons_json, change_class, '2026-07-13T10:04:00Z', null, 'created',
          null, null, 0, 0, 0, null
        from attempts where id = 'attempt-1'`,
      )
      .run();

    await expect(loadLatestHandoffForAttempt(opened.database, "attempt-2")).resolves.toEqual(
      handoff,
    );
  });

  it("lists every open attempt with its recorded process identity", async () => {
    await expect(listInterruptedAttempts(opened.database)).resolves.toEqual([
      {
        attemptId: "attempt-1",
        processGroupId: 1230,
        processId: 1234,
      },
    ]);

    opened.sqlite.prepare("delete from live_sessions where attempt_id = 'attempt-1'").run();
    await expect(listInterruptedAttempts(opened.database)).resolves.toEqual([
      { attemptId: "attempt-1", processGroupId: null, processId: null },
    ]);
  });

  it("atomically closes a terminated owned process and requeues its claim", async () => {
    await recoverInterruptedAttempt(opened.database, {
      attemptId: "attempt-1",
      endedAt: "2026-07-13T10:03:00Z",
      latestHandoff: handoff,
      ownership: {
        kind: "terminated",
        processGroupId: 1230,
        processId: 1234,
        verifiedAt: "2026-07-13T10:02:59Z",
      },
      terminalResultId: "result-interrupted-1",
    });

    expect(
      opened.sqlite
        .prepare("select status, failure_class, total_tokens from attempts where id = 'attempt-1'")
        .get(),
    ).toEqual({ failure_class: "agent_process", status: "closed", total_tokens: 120 });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "restart_interrupted_attempt",
    });
    expect(
      opened.sqlite.prepare("select result_kind, payload_json from terminal_results").get(),
    ).toEqual({
      payload_json: JSON.stringify({
        evidence: [],
        failure_class: "agent_process",
        handoff,
        role: "implementation",
        status: "failed",
        summary: "Attempt interrupted during service restart",
      }),
      result_kind: "execution_failure",
    });
    expect(
      opened.sqlite.prepare("select reserved, consumed from budget_ledgers order by id").all(),
    ).toEqual([
      { consumed: 120, reserved: 0 },
      { consumed: 120, reserved: 0 },
      { consumed: 120, reserved: 0 },
    ]);
    expect(opened.sqlite.prepare("select ownership_verified_at from live_sessions").get()).toEqual({
      ownership_verified_at: "2026-07-13T10:02:59Z",
    });
  });

  it("rejects mismatched process identity without partially closing anything", async () => {
    await expect(
      recoverInterruptedAttempt(opened.database, {
        attemptId: "attempt-1",
        endedAt: "2026-07-13T10:03:00Z",
        latestHandoff: handoff,
        ownership: {
          kind: "terminated",
          processGroupId: 9999,
          processId: 1234,
          verifiedAt: "2026-07-13T10:02:59Z",
        },
        terminalResultId: "result-interrupted-1",
      }),
    ).rejects.toThrow("recovery.process_identity_mismatch");

    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "running",
    });
    expect(opened.sqlite.prepare("select count(*) as count from terminal_results").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select reserved from budget_ledgers order by id").all()).toEqual([
      { reserved: 200 },
      { reserved: 200 },
      { reserved: 200 },
    ]);
  });

  it("atomically settles and releases terminal tracker work after worker shutdown", async () => {
    opened.sqlite
      .prepare(
        `insert into issues (
          id, identifier, title, description, acceptance_criteria_json, state,
          labels_json, priority, blocked_by_json, assignee_id, repo_owner,
          repo_name, url, provider_revision, created_at, updated_at
        ) values (
          'issue-1', 'ORG-1', 'Issue', '', '["Work remains recoverable"]',
          'Done', '[]', null, '[]', null, 'owner', 'repo',
          'https://example.test/issues/1', 'revision-terminal',
          '2026-07-13T09:00:00Z', '2026-07-13T10:02:00Z'
        )`,
      )
      .run();
    await closeRunningAttemptForReconciliation(opened.database, {
      attemptId: "attempt-1",
      endedAt: "2026-07-13T10:03:00Z",
      failureClass: "task",
      nextClaim: { mode: "Released", reason: "tracker.terminal" },
      summary: "Tracker issue became terminal during execution",
      terminalResultId: "result-terminal-1",
    });

    expect(opened.sqlite.prepare("select status, failure_class from attempts").get()).toEqual({
      failure_class: "task",
      status: "closed",
    });
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite.prepare("select reserved, consumed from budget_ledgers order by id").all(),
    ).toEqual([
      { consumed: 120, reserved: 0 },
      { consumed: 120, reserved: 0 },
      { consumed: 120, reserved: 0 },
    ]);
  });
});
