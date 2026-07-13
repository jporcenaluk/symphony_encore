import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createContinuationDispatch } from "./continuation-dispatch-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-continuation-dispatch-"));
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
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason, retry_due_at, blocker_predicate,
        question_id, approval_request_id, last_comment_cursor
      ) values (
        'issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null,
        'Todo', 'plan_review_required', null, null, null, null, null
      )`,
    )
    .run();
  const insertLedger = opened.sqlite.prepare(
    `insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, 'tokens', 1000, 1000, 't1')`,
  );
  insertLedger.run("attempt-2:tokens", "attempt", "attempt-2");
  insertLedger.run("issue-1:tokens", "issue", "issue-1");
  insertLedger.run("fleet:tokens", "rolling_24h", "fleet");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const dispatch = {
  attempt: {
    attemptNumber: 2,
    changeClass: "high_risk" as const,
    computeProfile: "economy" as const,
    configSnapshotId: "config-1",
    costUsd: null,
    id: "attempt-2",
    model: "gpt-test",
    priceTableVersion: null,
    reasoningEffort: "low",
    role: "plan_review" as const,
    routingReasons: ["route.plan_review"],
    startedAt: "2026-07-13T10:02:00Z",
    workspacePath: "/tmp/work/issue-1",
  },
  claim: {
    acquiredAt: "2026-07-13T10:02:00Z",
    expiresAt: "2026-07-13T10:04:00Z",
    holder: "run-1",
    originStage: "Todo",
    reason: "plan_review",
  },
  reservation: {
    id: "reservation-2",
    ledgers: [
      { amount: 100, id: "attempt-2:tokens", version: 1 },
      { amount: 100, id: "issue-1:tokens", version: 1 },
      { amount: 100, id: "fleet:tokens", version: 1 },
    ],
  },
  workRef: { id: "issue-1", kind: "issue" as const },
};

describe("continuation dispatch transaction", () => {
  it("atomically converts the expected Ready claim into a charged running attempt", async () => {
    await createContinuationDispatch(opened.database, {
      dispatch,
      expectedReadyReason: "plan_review_required",
    });

    expect(opened.sqlite.prepare("select role, status from attempts").get()).toEqual({
      role: "plan_review",
      status: "created",
    });
    expect(opened.sqlite.prepare("select mode, reason, expires_at from claims").get()).toEqual({
      expires_at: "2026-07-13T10:04:00Z",
      mode: "Running",
      reason: "plan_review",
    });
    expect(opened.sqlite.prepare("select status from budget_reservations").get()).toEqual({
      status: "reserved",
    });
    expect(opened.sqlite.prepare("select reserved from budget_ledgers order by id").all()).toEqual([
      { reserved: 100 },
      { reserved: 100 },
      { reserved: 100 },
    ]);
  });

  it("rolls back when the Ready reason no longer authorizes this continuation", async () => {
    await expect(
      createContinuationDispatch(opened.database, {
        dispatch,
        expectedReadyReason: "implementation_rework",
      }),
    ).rejects.toThrow("continuation_dispatch.claim_not_ready");
    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select reserved from budget_ledgers order by id").all()).toEqual([
      { reserved: 0 },
      { reserved: 0 },
      { reserved: 0 },
    ]);
  });

  it("moves a repair SystemJob from rework to running with its continuation claim", async () => {
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, parent_work_ref_kind, parent_work_ref_id, repository, workspace_path,
          goal, acceptance_criteria_json, config_snapshot_id, status, created_at
        ) values ('repair-1', 'repair', 'issue', 'issue-1', 'owner/repo',
          '/tmp/work/_system/repair-repair-1', 'repair', '["restore"]', 'config-1',
          'rework', 't0')`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into stage_transitions (
          id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, entered_at,
          timestamp_source
        ) values ('repair-rework', 'system_job', 'repair-1', 'review', 'rework',
          'review.needs_rework', '2026-07-13T10:01:00Z', 'observed_estimate')`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values ('system_job', 'repair-1', 'run-1', 'Ready', 't0', 't1', null,
          'rework', 'review_rework')`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into budget_ledgers (
          id, scope, scope_id, unit, base_limit, effective_limit, updated_at
        ) values ('repair-attempt:tokens', 'attempt', 'repair-attempt', 'tokens', 1000, 1000, 't1'),
          ('repair-1:tokens', 'system_job', 'repair-1', 'tokens', 1000, 1000, 't1')`,
      )
      .run();
    await createContinuationDispatch(opened.database, {
      dispatch: {
        ...dispatch,
        attempt: {
          ...dispatch.attempt,
          id: "repair-attempt",
          role: "implementation",
          workspacePath: "/tmp/work/_system/repair-repair-1",
        },
        claim: { ...dispatch.claim, originStage: "rework", reason: "implementation_continuation" },
        reservation: {
          id: "repair-reservation",
          ledgers: [
            { amount: 100, id: "repair-attempt:tokens", version: 1 },
            { amount: 100, id: "repair-1:tokens", version: 1 },
            { amount: 100, id: "fleet:tokens", version: 1 },
          ],
        },
        workRef: { id: "repair-1", kind: "system_job" },
      },
      expectedReadyReason: "review_rework",
    });

    expect(
      opened.sqlite.prepare("select status from system_jobs where id = 'repair-1'").get(),
    ).toEqual({
      status: "running",
    });
    expect(
      opened.sqlite
        .prepare(
          "select from_stage, to_stage from stage_transitions where id = 'repair-attempt:stage'",
        )
        .get(),
    ).toEqual({ from_stage: "rework", to_stage: "running" });
  });
});
