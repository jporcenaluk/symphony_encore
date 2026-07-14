import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapterManifest, Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  type OpenedDatabase,
  openBaselineStage,
  openDatabase,
  upsertIssue,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeInitialIssueDispatch } from "./issue-dispatch-executor.js";
import { composeInitialIssueDispatch } from "./issue-dispatch-record.js";

let directory: string;
let opened: OpenedDatabase;

const issue: Issue = {
  acceptance_criteria: ["Ship the implementation"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Implement it",
  id: "issue-1",
  identifier: "ORG/repo#1",
  labels: ["ready"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "ORG",
  state: "Todo",
  title: "Implement feature",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/1",
};

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
  directory = await mkdtemp(path.join(tmpdir(), "symphony-issue-dispatch-executor-"));
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
  await upsertIssue(opened.database, issue, "revision-1");
  await openBaselineStage(opened.database, {
    enteredAt: "2026-07-13T09:30:00Z",
    id: "stage-1",
    reason: "tracker.first_observation",
    timestampSource: "tracker",
    toStage: "Todo",
    workRef: { id: issue.id, kind: "issue" },
  });
  const insertLedger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, version, updated_at
    ) values (?, ?, ?, 'tokens', 1000, 1000, 1, 't0')
  `);
  insertLedger.run("attempt-ledger", "attempt", "attempt-1");
  insertLedger.run("issue-ledger", "issue", "issue-1");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function record() {
  return composeInitialIssueDispatch({
    attemptId: "attempt-1",
    attemptNumber: 1,
    authorizationId: "authorization-1",
    budgetLedgers: [
      { amount: 200, id: "attempt-ledger", version: 1 },
      { amount: 200, id: "issue-ledger", version: 1 },
      { amount: 200, id: "fleet-ledger", version: 1 },
    ],
    changeClass: "standard",
    classificationReasons: ["classification.unknown"],
    configSnapshotId: "config-1",
    eventId: "event-1",
    intentId: "intent-1",
    issue,
    leaseExpiresAt: "2026-07-13T10:02:00Z",
    manifest,
    now: "2026-07-13T10:00:00Z",
    providerRevision: "revision-1",
    reservationId: "reservation-1",
    route: {
      model: "gpt-test",
      profile: "standard",
      reasoningEffort: "medium",
      reasons: ["route.implementation.standard"],
    },
    serviceRunId: "run-1",
    stageTransitionId: "stage-2",
    workspacePath: "/tmp/work/ORG_repo_1",
  });
}

describe("initial issue dispatch execution", () => {
  it("applies the exact durable intent, commits the receipt and stage, then launches", async () => {
    const launchWorker = vi.fn(async () => ({ processId: 123 }));
    const updateIssueLane = vi.fn(async () => ({
      providerRequestId: "provider-1",
      responsePayloadHash: "sha256:response",
      result: "lane_updated",
      resultRevision: "revision-2",
    }));
    const timestamps = ["2026-07-13T10:00:01Z", "2026-07-13T10:00:03Z"];
    await expect(
      executeInitialIssueDispatch({
        database: opened.database,
        launchWorker,
        now: () => timestamps.shift() as string,
        record: record(),
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        tracker: {
          createOrUpdateComment: vi.fn(),
          fetchCandidates: vi.fn(),
          fetchCommentsSince: vi.fn(),
          fetchIssuesByStates: vi.fn(),
          fetchStatesByIds: vi.fn(),
          updateIssueLane,
        },
      }),
    ).resolves.toEqual({ processId: 123 });

    expect(updateIssueLane).toHaveBeenCalledWith(
      "issue-1",
      "In Progress",
      "dispatch.eligible",
      record().authority,
    );
    expect(launchWorker).toHaveBeenCalledOnce();
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "revision-2",
      state: "In Progress",
    });
    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "applied",
    });
    expect(
      opened.sqlite
        .prepare(
          "select attempt_id, from_stage, to_stage from stage_transitions where id = 'stage-2'",
        )
        .get(),
    ).toEqual({ attempt_id: "attempt-1", from_stage: "Todo", to_stage: "In Progress" });
  });

  it("does not launch or invent a stage when the provider omits its resulting revision", async () => {
    const launchWorker = vi.fn();
    await expect(
      executeInitialIssueDispatch({
        database: opened.database,
        launchWorker,
        now: () => "2026-07-13T10:00:01Z",
        record: record(),
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        tracker: {
          createOrUpdateComment: vi.fn(),
          fetchCandidates: vi.fn(),
          fetchCommentsSince: vi.fn(),
          fetchIssuesByStates: vi.fn(),
          fetchStatesByIds: vi.fn(),
          updateIssueLane: vi.fn(async () => ({
            providerRequestId: "provider-1",
            responsePayloadHash: "sha256:response",
            result: "lane_updated",
            resultRevision: null,
          })),
        },
      }),
    ).rejects.toThrow("tracker.dispatch_revision_missing");
    expect(launchWorker).not.toHaveBeenCalled();
    expect(opened.sqlite.prepare("select state from issues").get()).toEqual({ state: "Todo" });
    expect(opened.sqlite.prepare("select status from side_effect_intents").get()).toEqual({
      status: "applying",
    });
  });
});
