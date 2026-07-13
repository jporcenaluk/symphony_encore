import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMigrations,
  beginServiceRun,
  createAuthorizedIntent,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverCorruptOperatorStore } from "./corrupt-store-recovery.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-corrupt-store-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  await beginServiceRun(opened.database, {
    hostId: "host-1",
    id: "run-1",
    serviceVersion: "0.0.0",
    startReason: "startup",
    startedAt: "2026-07-13T10:00:00Z",
    startupConfigSnapshotId: "config-1",
  });
  opened.sqlite
    .prepare(`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status
      ) values ('attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/issue-1',
        'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't0', 'running')
    `)
    .run();
  opened.sqlite
    .prepare(`
      insert into live_sessions (
        attempt_id, session_id, thread_id, process_id, process_group_id,
        adapter_version, protocol_schema_hash, last_event, last_event_at
      ) values ('attempt-1', 'session-1', 'thread-1', 101, 100, '1', 'schema', 'turn', 't0')
    `)
    .run();
  await createAuthorizedIntent(opened.database, {
    authorization: {
      action: "tracker.update_lane",
      actor_id: "orchestrator",
      actor_kind: "orchestrator_policy",
      attempt_role: null,
      authorized_at: "t0",
      config_snapshot_id: "config-1",
      decision_rule_ids: ["lane-policy"],
      expires_at: "t9",
      id: "authorization-1",
      idempotency_key: "lane:issue-1:review",
      intent_id: "intent-1",
      observed_state_ref: "todo",
      operator_capability: null,
      scope: "work",
      service_run_id: "run-1",
      target: "issue-1",
      target_revision: "revision-1",
      work_ref: { issue_id: "issue-1" },
    },
    intent: {
      action: "tracker.update_lane",
      attempt_id: "attempt-1",
      authorization_id: "authorization-1",
      created_at: "t0",
      id: "intent-1",
      idempotency_key: "lane:issue-1:review",
      request_payload_hash: "sha256:request",
      scope: "work",
      service_run_id: "run-1",
      status: "pending",
      target: "issue-1",
      target_revision: "revision-1",
      updated_at: "t0",
      work_ref: { issue_id: "issue-1" },
    },
  });
  return opened;
}

describe("operator-store corruption recovery", () => {
  it("terminates owned processes, records observed receipts, then records the failure", async () => {
    const opened = await fixture();
    const terminateProcessGroup = vi.fn(async () => ({ outcome: "terminated" as const }));
    const lookupReceiptByIdempotencyKey = vi.fn(async () => ({
      applied_at: "2026-07-13T10:01:00Z",
      intent_id: "intent-1",
      provider_request_id: "provider-1",
      response_payload_hash: "sha256:response",
      result: "lane_updated",
      result_revision: "revision-2",
    }));

    await expect(
      recoverCorruptOperatorStore({
        database: opened.database,
        failureId: "failure-1",
        lookupReceiptByIdempotencyKey,
        occurredAt: "2026-07-13T10:01:00Z",
        populatedTables: ["attempts", "live_sessions", "side_effect_intents"],
        terminateProcessGroup,
      }),
    ).resolves.toEqual({
      attempts_inspected: 1,
      owned_processes_terminated: 1,
      receipts_recorded: 1,
      recovery_complete: true,
      unreconciled_intents_inspected: 1,
    });
    expect(terminateProcessGroup).toHaveBeenCalledWith({
      killWaitMs: 5_000,
      processGroupId: 100,
      processId: 101,
      terminateWaitMs: 1_000,
    });
    expect(lookupReceiptByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: "intent-1", idempotency_key: "lane:issue-1:review" }),
    );
    expect(opened.sqlite.prepare("select ownership_verified_at from live_sessions").get()).toEqual({
      ownership_verified_at: "2026-07-13T10:01:00Z",
    });
    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "applied",
    });
    expect(opened.sqlite.prepare("select reason_code from startup_failures").get()).toEqual({
      reason_code: "operator_store_missing_nonpristine",
    });
  });

  it("records incomplete reconciliation and never applies an intent without a provider lookup", async () => {
    const opened = await fixture();

    const result = await recoverCorruptOperatorStore({
      database: opened.database,
      failureId: "failure-2",
      occurredAt: "2026-07-13T10:01:00Z",
      populatedTables: ["side_effect_intents"],
      terminateProcessGroup: async () => ({ outcome: "terminated" }),
    });

    expect(result).toEqual({
      attempts_inspected: 1,
      owned_processes_terminated: 1,
      receipts_recorded: 0,
      recovery_complete: false,
      recovery_error: "provider_reconciliation_unavailable:intent-1",
      unreconciled_intents_inspected: 1,
    });
    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "pending",
    });
  });
});
