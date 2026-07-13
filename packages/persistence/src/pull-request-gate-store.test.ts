import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import {
  loadPendingPullRequestGate,
  observePullRequestGateMaterial,
  routePullRequestGateDecision,
} from "./pull-request-gate-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("pull-request gate persistence", () => {
  it("loads the latest durable link and preserves settle time while material changes", async () => {
    const opened = await fixture();
    await expect(
      loadPendingPullRequestGate(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      baseRef: "main",
      baseSha: "abc1234",
      branch: "symphony/issue-1",
      cycle: 1,
      headSha: "def5678",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      repository: "owner/repo",
    });
    await expect(
      observePullRequestGateMaterial(opened.database, {
        materialHash: "sha256:first",
        observedAt: "2026-07-13T10:05:00Z",
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).resolves.toEqual({
      materialSince: "2026-07-13T10:05:00Z",
      settleStartedAt: "2026-07-13T10:05:00Z",
    });
    await expect(
      observePullRequestGateMaterial(opened.database, {
        materialHash: "sha256:second",
        observedAt: "2026-07-13T10:06:00Z",
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).resolves.toEqual({
      materialSince: "2026-07-13T10:06:00Z",
      settleStartedAt: "2026-07-13T10:05:00Z",
    });
    await opened.close();
  });

  it("routes allow, waits durably, and parks an expired wait with its typed predicate", async () => {
    const allowed = await fixture();
    await routePullRequestGateDecision(allowed.database, {
      decision: { decision: "allow" },
      now: "2026-07-13T10:05:00Z",
      retryDueAt: null,
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(allowed.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_required",
    });
    await allowed.close();

    const waiting = await fixture();
    await routePullRequestGateDecision(waiting.database, {
      decision: { decision: "wait", reason: "pull_request.check_pending:ci / required" },
      now: "2026-07-13T10:05:00Z",
      retryDueAt: "2026-07-13T10:05:30Z",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(waiting.sqlite.prepare("select mode, reason, retry_due_at from claims").get()).toEqual({
      mode: "RetryQueued",
      reason: "pull_request_hygiene_required",
      retry_due_at: "2026-07-13T10:05:30Z",
    });
    await waiting.close();

    const expired = await fixture();
    await routePullRequestGateDecision(expired.database, {
      decision: { decision: "wait", reason: "pull_request.mergeability_pending" },
      now: "2026-07-13T10:35:00Z",
      retryDueAt: null,
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(
      expired.sqlite.prepare("select mode, reason, blocker_predicate from claims").get(),
    ).toEqual({
      blocker_predicate: "pull_request.mergeability_pending",
      mode: "AwaitingHuman",
      reason: "blocked",
    });
    expect(expired.sqlite.prepare("select origin_stage, reason from parked_work").get()).toEqual({
      origin_stage: "Review",
      reason: "blocked",
    });
    await expired.close();
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-pr-gate-"));
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
