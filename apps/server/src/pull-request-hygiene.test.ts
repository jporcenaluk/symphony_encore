import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PullRequestSnapshot, WorkRef } from "@symphony/contracts";
import { applyMigrations, loadPendingPullRequestGate, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPullRequestHygiene } from "./pull-request-hygiene.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("pull-request hygiene runner", () => {
  it("routes a complete current-head snapshot to paid review", async () => {
    const opened = await fixture();
    const target = await loadPendingPullRequestGate(opened.database, {
      id: "issue-1",
      kind: "issue",
    });
    if (!target) throw new Error("missing hygiene fixture target");
    const fetchPullRequestSnapshot = vi.fn(async (_workRef: WorkRef) => snapshot());

    await expect(
      runPullRequestHygiene({
        acceptedCheckConclusions: ["success", "neutral", "skipped"],
        database: opened.database,
        fetchPullRequestSnapshot,
        now: () => "2026-07-13T10:05:00Z",
        pollIntervalMs: 30_000,
        quietPeriodMs: 0,
        requiredChecks: ["ci / required"],
        settleTimeoutMs: 1_800_000,
        target,
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).resolves.toEqual({ decision: "allow" });
    expect(fetchPullRequestSnapshot).toHaveBeenCalledWith({ issue_id: "issue-1" });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_required",
    });
    await opened.close();
  });

  it("queues incomplete evidence until the durable settle timeout expires", async () => {
    const opened = await fixture();
    const target = await loadPendingPullRequestGate(opened.database, {
      id: "issue-1",
      kind: "issue",
    });
    if (!target) throw new Error("missing hygiene fixture target");
    const pending = snapshot();
    const requiredCheck = pending.checks[0];
    if (!requiredCheck) throw new Error("missing hygiene fixture check");
    pending.checks[0] = { ...requiredCheck, conclusion: null, status: "in_progress" };

    await runPullRequestHygiene({
      acceptedCheckConclusions: ["success"],
      database: opened.database,
      fetchPullRequestSnapshot: vi.fn(async () => pending),
      now: () => "2026-07-13T10:05:00Z",
      pollIntervalMs: 30_000,
      quietPeriodMs: 0,
      requiredChecks: ["ci / required"],
      settleTimeoutMs: 60_000,
      target,
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(opened.sqlite.prepare("select mode, reason, retry_due_at from claims").get()).toEqual({
      mode: "RetryQueued",
      reason: "pull_request_hygiene_required",
      retry_due_at: "2026-07-13T10:05:30.000Z",
    });
    await opened.close();
  });
});

function snapshot(): PullRequestSnapshot {
  return {
    base_ref: "main",
    checks: [
      {
        conclusion: "success",
        name: "ci / required",
        required_source: "union",
        status: "completed",
        target_sha: "def5678",
        url: "https://github.com/owner/repo/actions/runs/1",
      },
    ],
    head_sha: "def5678",
    is_draft: false,
    mergeable: true,
    observed_base_sha: "abc1234",
    post_merge_checks: [],
    pr_number: 42,
    pr_state: "open",
    pr_url: "https://github.com/owner/repo/pull/42",
    required_check_source: "union",
    review_decision: "none",
    reviews: [],
    unresolved_threads: [],
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-pr-hygiene-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Ready', '2026-07-13T10:00:00Z',
        '2026-07-13T10:04:00Z', null, 'In Progress', 'pull_request_hygiene_required'
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into repository_links (
        id, work_ref_kind, work_ref_id, cycle, kind, repo_owner, repo_name, branch,
        pull_request_number, pull_request_url, head_sha, base_ref, base_sha, state,
        created_at, updated_at
      ) values (
        'link-1', 'issue', 'issue-1', 1, 'primary', 'owner', 'repo',
        'symphony/issue-1', 42, 'https://github.com/owner/repo/pull/42',
        'def5678', 'main', 'abc1234', 'open',
        '2026-07-13T10:04:00Z', '2026-07-13T10:04:00Z'
      )`,
    )
    .run();
  return opened;
}
