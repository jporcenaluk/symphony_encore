import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MutationAuthorization, SideEffectIntent } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { recordLaneMutationReceipt } from "./lane-mutation-receipt.js";
import { createAuthorizedIntent, markIntentApplying } from "./side-effect-store.js";
import { openBaselineStage } from "./stage-transition.js";

const directories: string[] = [];
const databases: OpenedDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-lane-receipt-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
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
      `insert into issues (
        id, identifier, title, description, acceptance_criteria_json, state,
        labels_json, priority, blocked_by_json, assignee_id, repo_owner,
        repo_name, url, provider_revision, created_at, updated_at
      ) values (
        'issue-1', 'ORG-1', 'Issue', '', '[]', 'Todo', '[]', null, '[]', null,
        'owner', 'repo', 'https://example.test/issues/1', 'revision-1',
        '2026-07-13T09:00:00Z', '2026-07-13T10:00:00Z'
      )`,
    )
    .run();
  await openBaselineStage(opened.database, {
    enteredAt: "2026-07-13T10:00:00Z",
    id: "stage-1",
    reason: "baseline",
    timestampSource: "tracker",
    toStage: "Todo",
    workRef: { id: "issue-1", kind: "issue" },
  });

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
    idempotency_key: "issue-1:lane:revision-1",
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
    request_payload_hash: "sha256:request",
    scope: "work",
    service_run_id: "run-1",
    status: "pending",
    target: authorization.target,
    target_revision: authorization.target_revision,
    updated_at: "2026-07-13T10:00:01Z",
    work_ref: { issue_id: "issue-1" },
  };
  await createAuthorizedIntent(opened.database, { authorization, intent });
  await markIntentApplying(opened.database, "intent-1", "2026-07-13T10:00:02Z");
  return opened;
}

describe("receipt-confirmed lane transitions", () => {
  it("commits the receipt and confirmed stage boundary atomically", async () => {
    const opened = await fixture();
    await recordLaneMutationReceipt(opened.database, {
      receipt: {
        applied_at: "2026-07-13T10:00:03Z",
        intent_id: "intent-1",
        provider_request_id: "provider-1",
        response_payload_hash: "sha256:response",
        result: "lane_updated",
        result_revision: "revision-2",
      },
      transition: {
        attemptId: null,
        confirmedExternalRevision: "revision-2",
        enteredAt: "2026-07-13T10:00:03Z",
        expectedFromStage: "Todo",
        id: "stage-2",
        reason: "implementation_start",
        timestampSource: "receipt",
        toStage: "In Progress",
        workRef: { id: "issue-1", kind: "issue" },
      },
    });

    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "applied",
    });
    expect(
      opened.sqlite
        .prepare("select from_stage, to_stage from stage_transitions order by entered_at")
        .all(),
    ).toEqual([
      { from_stage: null, to_stage: "Todo" },
      { from_stage: "Todo", to_stage: "In Progress" },
    ]);
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "revision-2",
      state: "In Progress",
    });
  });

  it("rolls back the receipt when the confirmed transition is invalid", async () => {
    const opened = await fixture();
    await expect(
      recordLaneMutationReceipt(opened.database, {
        receipt: {
          applied_at: "2026-07-13T10:00:03Z",
          intent_id: "intent-1",
          provider_request_id: "provider-1",
          response_payload_hash: "sha256:response",
          result: "lane_updated",
          result_revision: "revision-2",
        },
        transition: {
          attemptId: null,
          confirmedExternalRevision: "revision-2",
          enteredAt: "2026-07-13T10:00:03Z",
          expectedFromStage: "Review",
          id: "stage-2",
          reason: "wrong_source",
          timestampSource: "receipt",
          toStage: "Done",
          workRef: { id: "issue-1", kind: "issue" },
        },
      }),
    ).rejects.toThrow("Open stage does not match expected stage Review");

    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_receipts").get(),
    ).toEqual({ count: 0 });
    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "applying",
    });
  });
});
