import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MutationAuthorization, SideEffectIntent } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import {
  createAuthorizedIntent,
  loadUnreconciledIntents,
  markIntentApplying,
  recordSideEffectReceipt,
} from "./side-effect-store.js";

const directories: string[] = [];
const opened: OpenedDatabase[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function database(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-side-effect-"));
  directories.push(directory);
  const result = openDatabase(path.join(directory, "symphony.sqlite3"));
  opened.push(result);
  await applyMigrations(result.database);
  result.sqlite
    .prepare(`insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "config-1",
      "2026-07-13T10:00:00Z",
      "workflow-hash",
      0,
      "{}",
      "{}",
      "{}",
      "{}",
      "prompt-hash",
      "{}",
    );
  result.sqlite
    .prepare(
      `insert into service_runs (
        id, service_version, host_id, started_at, status,
        startup_config_snapshot_id, start_reason
      ) values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("run-1", "0.0.0", "host-1", "2026-07-13T10:00:00Z", "ready", "config-1", "startup");
  return result;
}

const authorization: MutationAuthorization = {
  action: "update_issue_lane",
  actor_id: "scheduler",
  actor_kind: "orchestrator_policy",
  attempt_role: "implementation",
  authorized_at: "2026-07-13T10:00:01Z",
  config_snapshot_id: "config-1",
  decision_rule_ids: ["lane.implementation_start"],
  expires_at: "2026-07-13T10:05:00Z",
  id: "auth-1",
  idempotency_key: "issue-1:update:revision-1",
  intent_id: "intent-1",
  observed_state_ref: "tracker-snapshot-1",
  operator_capability: null,
  scope: "work",
  service_run_id: "run-1",
  target: "issue-1:lane",
  target_revision: "revision-1",
  work_ref: { issue_id: "issue-1" },
};

const intent: SideEffectIntent = {
  action: authorization.action,
  attempt_id: null,
  authorization_id: authorization.id,
  created_at: "2026-07-13T10:00:01Z",
  id: authorization.intent_id,
  idempotency_key: authorization.idempotency_key,
  request_payload_hash: "sha256:request-1",
  scope: "work",
  service_run_id: "run-1",
  status: "pending",
  target: authorization.target,
  target_revision: authorization.target_revision,
  updated_at: "2026-07-13T10:00:01Z",
  work_ref: { issue_id: "issue-1" },
};

describe("authorized side-effect intents", () => {
  it("commits the exact authorization and intent atomically and replays it", async () => {
    const db = await database();
    expect(await createAuthorizedIntent(db.database, { authorization, intent })).toEqual({
      replayed: false,
    });
    expect(await createAuthorizedIntent(db.database, { authorization, intent })).toEqual({
      replayed: true,
    });
    expect(
      db.sqlite.prepare("select count(*) as count from mutation_authorizations").get(),
    ).toEqual({ count: 1 });
    expect(db.sqlite.prepare("select count(*) as count from side_effect_intents").get()).toEqual({
      count: 1,
    });
  });

  it("rejects idempotency reuse with a different request payload", async () => {
    const db = await database();
    await createAuthorizedIntent(db.database, { authorization, intent });
    await expect(
      createAuthorizedIntent(db.database, {
        authorization: { ...authorization, id: "auth-2", intent_id: "intent-2" },
        intent: {
          ...intent,
          authorization_id: "auth-2",
          id: "intent-2",
          request_payload_hash: "sha256:different",
        },
      }),
    ).rejects.toThrow("side_effect.idempotency_conflict");
  });

  it("reconciles receipt-less intents and atomically records provider receipts", async () => {
    const db = await database();
    await createAuthorizedIntent(db.database, { authorization, intent });
    await markIntentApplying(db.database, "intent-1", "2026-07-13T10:00:02Z");
    expect(await loadUnreconciledIntents(db.database)).toHaveLength(1);

    await recordSideEffectReceipt(db.database, {
      applied_at: "2026-07-13T10:00:03Z",
      intent_id: "intent-1",
      provider_request_id: "provider-1",
      response_payload_hash: "sha256:response-1",
      result: "lane_updated",
      result_revision: "revision-2",
    });

    expect(await loadUnreconciledIntents(db.database)).toEqual([]);
    expect(
      db.sqlite.prepare("select status from side_effect_intents where id = 'intent-1'").get(),
    ).toEqual({ status: "applied" });
  });
});
