import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";
import { openBaselineStage } from "./stage-transition.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-dispatch-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
  opened.sqlite
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
  opened.sqlite
    .prepare(
      `insert into service_runs (
        id, service_version, host_id, started_at, ended_at, status, start_reason,
        end_reason, startup_config_snapshot_id
      ) values (?, ?, ?, ?, null, ?, ?, null, ?)`,
    )
    .run("service-1", "0.0.0", "host-1", "2026-07-13T10:00:00Z", "ready", "startup", "config-1");
  const insertLedger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLedger.run("attempt-ledger", "attempt", "attempt-1", "tokens", 400, 400, "now");
  insertLedger.run("issue-ledger", "issue", "issue-1", "tokens", 1000, 1000, "now");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet", "tokens", 5000, 5000, "now");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const dispatch = {
  attempt: {
    attemptNumber: 1,
    changeClass: "standard" as const,
    computeProfile: "standard" as const,
    configSnapshotId: "config-1",
    costUsd: null,
    id: "attempt-1",
    model: "provider-model",
    priceTableVersion: null,
    reasoningEffort: "medium",
    role: "implementation" as const,
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
  workRef: { kind: "issue" as const, id: "issue-1" },
};

const issueMutation = {
  authorization: {
    action: "update_issue_lane",
    actor_id: "scheduler",
    actor_kind: "orchestrator_policy" as const,
    attempt_role: "implementation" as const,
    authorized_at: "2026-07-13T10:00:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["dispatch.eligible"],
    expires_at: "2026-07-13T10:02:00Z",
    id: "authorization-1",
    idempotency_key: "dispatch:issue-1:attempt-1",
    intent_id: "intent-1",
    observed_state_ref: "tracker-revision-1",
    operator_capability: null,
    scope: "work" as const,
    service_run_id: "service-1",
    target: "issue-1",
    target_revision: "tracker-revision-1",
    work_ref: { issue_id: "issue-1" },
  },
  event: {
    attemptId: "attempt-1",
    changeClass: "standard" as const,
    computeProfile: "standard" as const,
    costUsd: null,
    eventName: "dispatch.pending",
    id: "event-1",
    payload: { target_lane: "In Progress" },
    reasonCode: "dispatch.eligible",
    result: "pending",
    serviceRunId: "service-1",
    timestamp: "2026-07-13T10:00:00Z",
    workRef: { issue_id: "issue-1" },
  },
  intent: {
    action: "update_issue_lane",
    attempt_id: "attempt-1",
    authorization_id: "authorization-1",
    created_at: "2026-07-13T10:00:00Z",
    id: "intent-1",
    idempotency_key: "dispatch:issue-1:attempt-1",
    request_payload_hash: "sha256:lane-in-progress",
    scope: "work" as const,
    service_run_id: "service-1",
    status: "pending" as const,
    target: "issue-1",
    target_revision: "tracker-revision-1",
    updated_at: "2026-07-13T10:00:00Z",
    work_ref: { issue_id: "issue-1" },
  },
};

describe("dispatch transaction", () => {
  it("commits the claim, attempt, and every budget reservation together", async () => {
    await createDispatch(opened.database, dispatch);

    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 1,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from budget_reservation_ledgers").get(),
    ).toEqual({ count: 3 });
    expect(
      opened.sqlite.prepare("select id, reserved from budget_ledgers order by id").all(),
    ).toEqual([
      { id: "attempt-ledger", reserved: 200 },
      { id: "fleet-ledger", reserved: 200 },
      { id: "issue-ledger", reserved: 200 },
    ]);
  });

  it("atomically commits the issue lane intent, authorization, and dispatch event", async () => {
    await createDispatch(opened.database, { ...dispatch, issueMutation });

    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 1,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from mutation_authorizations").get(),
    ).toEqual({
      count: 1,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_intents").get(),
    ).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select count(*) as count from event_records").get()).toEqual({
      count: 1,
    });
  });

  it("rolls back dispatch when the issue mutation authority does not exactly match", async () => {
    await expect(
      createDispatch(opened.database, {
        ...dispatch,
        issueMutation: {
          ...issueMutation,
          authorization: { ...issueMutation.authorization, target: "wrong-issue" },
        },
      }),
    ).rejects.toThrow("side_effect.authorization_mismatch");

    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_intents").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("atomically moves a SystemJob from queued to running without a tracker intent", async () => {
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, parent_work_ref_kind, parent_work_ref_id, repository, goal,
          acceptance_criteria_json, config_snapshot_id, status, workspace_path,
          created_at, started_at, ended_at, final_result_id, input_tokens,
          output_tokens, cost_usd
        ) values (?, 'repair', 'issue', 'issue-parent', 'owner/repo', 'repair',
          '[]', 'config-1', 'queued', '/tmp/work/job-1', ?, null, null, null, 0, 0, null)`,
      )
      .run("job-1", "2026-07-13T09:59:00Z");
    await openBaselineStage(opened.database, {
      enteredAt: "2026-07-13T09:59:00Z",
      id: "stage-job-queued",
      reason: "job_created",
      timestampSource: "observed_estimate",
      toStage: "queued",
      workRef: { id: "job-1", kind: "system_job" },
    });

    await createDispatch(opened.database, {
      ...dispatch,
      attempt: {
        ...dispatch.attempt,
        id: "attempt-job-1",
        workspacePath: "/tmp/work/job-1",
      },
      reservation: { ...dispatch.reservation, id: "reservation-job-1" },
      systemJobTransition: {
        attemptId: "attempt-job-1",
        confirmedExternalRevision: null,
        enteredAt: "2026-07-13T10:00:00Z",
        expectedFromStage: "queued",
        id: "stage-job-running",
        reason: "dispatch",
        timestampSource: "observed_estimate",
        toStage: "running",
        workRef: { id: "job-1", kind: "system_job" },
      },
      workRef: { id: "job-1", kind: "system_job" },
    });

    expect(
      opened.sqlite
        .prepare(
          "select from_stage, to_stage, attempt_id from stage_transitions where id = 'stage-job-running'",
        )
        .get(),
    ).toEqual({ attempt_id: "attempt-job-1", from_stage: "queued", to_stage: "running" });
    expect(
      opened.sqlite.prepare("select status from system_jobs where id = 'job-1'").get(),
    ).toEqual({
      status: "running",
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_intents").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("rolls back every write when a work reference is already claimed", async () => {
    await createDispatch(opened.database, dispatch);

    await expect(
      createDispatch(opened.database, {
        ...dispatch,
        attempt: { ...dispatch.attempt, attemptNumber: 2, id: "attempt-2" },
        reservation: { ...dispatch.reservation, id: "reservation-2" },
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/u);

    expect(
      opened.sqlite.prepare("select count(*) as count from attempts where id = 'attempt-2'").get(),
    ).toEqual({ count: 0 });
    expect(
      opened.sqlite
        .prepare("select count(*) as count from budget_reservations where id = 'reservation-2'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      opened.sqlite.prepare("select reserved from budget_ledgers where id = 'issue-ledger'").get(),
    ).toEqual({ reserved: 200 });
  });

  it("rolls back when any ledger cannot fit the reservation", async () => {
    opened.sqlite
      .prepare("update budget_ledgers set consumed = 900 where id = 'issue-ledger'")
      .run();

    await expect(createDispatch(opened.database, dispatch)).rejects.toThrow(
      "Budget reservation denied for ledger issue-ledger",
    );
    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite
        .prepare("select reserved from budget_ledgers where id = 'attempt-ledger'")
        .get(),
    ).toEqual({ reserved: 0 });
  });
});
