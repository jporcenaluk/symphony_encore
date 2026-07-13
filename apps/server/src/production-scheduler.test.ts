import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionScheduler } from "./production-scheduler.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const effectiveConfig = {
  "agent.max_retry_backoff_ms": 30_000,
  "agent.stall_timeout_ms": 300_000,
  "env.allowlist": [],
  "hooks.before_remove": null,
  "hooks.timeout_ms": 60_000,
  "persistence.lease_ttl_ms": 120_000,
  "polling.interval_ms": 30_000,
  "tracker.acceptance_criteria_heading": "Acceptance Criteria",
  "tracker.assignee": null,
  "tracker.owner": "owner",
  "tracker.priority_field": "Priority",
  "tracker.priority_order": ["P0", "P1"],
  "tracker.project_number": 1,
  "tracker.repo_name": "repo",
  "tracker.repo_owner": "owner",
  "tracker.required_labels": [],
  "tracker.status_field": "Status",
  "workspace.root": "/tmp/workspaces",
};

describe("production reconciliation scheduler", () => {
  it("starts with an immediate candidate-sync tick and no running-state refresh", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-production-scheduler-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(),
    };
    const scheduler = createProductionScheduler({
      database: opened.database,
      environment: {},
      serviceRunId: "run-1",
      snapshot: { effectiveConfig } as never,
      tracker,
    });

    await scheduler.start();
    await scheduler.close();
    expect(tracker.fetchCandidates).toHaveBeenCalledOnce();
    expect(tracker.fetchIssuesByStates).not.toHaveBeenCalled();
    expect(tracker.fetchStatesByIds).not.toHaveBeenCalled();
    await opened.close();
  });

  it("fails construction when a required scheduler value is absent", () => {
    expect(() =>
      createProductionScheduler({
        database: {} as never,
        environment: {},
        serviceRunId: "run-1",
        snapshot: { effectiveConfig: {} } as never,
        tracker: {} as never,
      }),
    ).toThrow("scheduler.config:env.allowlist");
  });
});
