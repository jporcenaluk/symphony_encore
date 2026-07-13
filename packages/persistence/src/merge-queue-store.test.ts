import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import {
  beginMergeQueueLanding,
  beginRepositoryBranchUpdate,
  commitMergeQueueLanding,
  commitPostMergeRepairCycle,
  commitPostMergeSuccess,
  commitRepositoryBranchUpdate,
  loadAuthorizedMergeLogins,
  loadPendingBaseUpdate,
  loadPendingMergeQueue,
  loadPendingPostMerge,
} from "./merge-queue-store.js";
import { createAuthorizedIntent } from "./side-effect-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("merge queue persistence", () => {
  it("loads an approved immutable target and authorized operator logins", async () => {
    const opened = await fixture();
    await expect(
      loadPendingMergeQueue(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      attemptId: "attempt-1",
      baseRef: "main",
      baseSha: "abc1234",
      branch: "symphony/issue-1",
      changeClass: "standard",
      configSnapshotId: "config-1",
      headSha: "def5678",
      patchIdentity: "sha256:patch",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      repository: "owner/repo",
      reviewSetId: "review-set-1",
      workspacePath: "/work/issue-1",
    });
    await expect(loadAuthorizedMergeLogins(opened.database)).resolves.toEqual(["maintainer"]);
    await opened.close();
  });

  it("persists the repository lock before landing and atomically records the merge receipt", async () => {
    const opened = await fixture();
    const target = await loadPendingMergeQueue(opened.database, { id: "issue-1", kind: "issue" });
    expect(target).not.toBeNull();
    await beginMergeQueueLanding(opened.database, {
      baseSha: "abc1234",
      headSha: "def5678",
      now: "2026-07-13T10:10:00Z",
      repository: "owner/repo",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(opened.sqlite.prepare("select state from repository_merge_queue_entries").get()).toEqual(
      { state: "landing" },
    );
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "merge_queue_landing",
    });

    await createAuthorizedIntent(opened.database, authorizedIntent("merge-intent"));
    await commitMergeQueueLanding(opened.database, {
      mergeSha: "fedcba9",
      now: "2026-07-13T10:11:00Z",
      receipt: {
        applied_at: "2026-07-13T10:11:00Z",
        intent_id: "merge-intent",
        provider_request_id: "REQ-MERGE",
        response_payload_hash: "sha256:merge-response",
        result: "merged",
        result_revision: "fedcba9",
      },
      retryDueAt: "2026-07-13T10:11:30Z",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(
      opened.sqlite.prepare("select state, merge_sha from repository_merge_queue_entries").get(),
    ).toEqual({ merge_sha: "fedcba9", state: "post_merge" });
    expect(opened.sqlite.prepare("select state from repository_links").get()).toEqual({
      state: "merged",
    });
    expect(opened.sqlite.prepare("select mode, reason, retry_due_at from claims").get()).toEqual({
      mode: "RetryQueued",
      reason: "post_merge_verification_required",
      retry_due_at: "2026-07-13T10:11:30Z",
    });
    await opened.close();
  });

  it("loads post-merge work and atomically commits the Done lane receipt", async () => {
    const opened = await fixture();
    await beginMergeQueueLanding(opened.database, {
      baseSha: "abc1234",
      headSha: "def5678",
      now: "2026-07-13T10:10:00Z",
      repository: "owner/repo",
      workRef: { id: "issue-1", kind: "issue" },
    });
    await createAuthorizedIntent(opened.database, authorizedIntent("merge-intent"));
    await commitMergeQueueLanding(opened.database, {
      mergeSha: "fedcba9",
      now: "2026-07-13T10:11:00Z",
      receipt: {
        applied_at: "2026-07-13T10:11:00Z",
        intent_id: "merge-intent",
        provider_request_id: "REQ-MERGE",
        response_payload_hash: "sha256:merge-response",
        result: "merged",
        result_revision: "fedcba9",
      },
      retryDueAt: "2026-07-13T10:11:30Z",
      workRef: { id: "issue-1", kind: "issue" },
    });
    opened.sqlite
      .prepare(
        `update claims set mode = 'Ready', retry_due_at = null
         where work_ref_kind = 'issue' and work_ref_id = 'issue-1'`,
      )
      .run();
    await expect(
      loadPendingPostMerge(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      attemptId: "attempt-1",
      configSnapshotId: "config-1",
      mergeSha: "fedcba9",
      providerRevision: "provider-revision-1",
      repository: "owner/repo",
      startedAt: "2026-07-13T10:10:00Z",
    });

    await createAuthorizedIntent(opened.database, trackerIntent("done-intent"));
    await commitPostMergeSuccess(opened.database, {
      now: "2026-07-13T10:12:00Z",
      receipt: {
        applied_at: "2026-07-13T10:12:00Z",
        intent_id: "done-intent",
        provider_request_id: "REQ-DONE",
        response_payload_hash: "sha256:done-response",
        result: "updated",
        result_revision: "provider-revision-2",
      },
      transitionId: "transition-done",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "provider-revision-2",
      state: "Done",
    });
    expect(opened.sqlite.prepare("select state from repository_merge_queue_entries").get()).toEqual(
      { state: "completed" },
    );
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });

  it("persists an exclusive base update and routes the synchronized head to verification", async () => {
    const opened = await fixture();
    opened.sqlite.prepare("update claims set reason = 'base_update_required'").run();
    await expect(
      loadPendingBaseUpdate(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toMatchObject({ baseSha: "abc1234", headSha: "def5678" });
    await beginRepositoryBranchUpdate(opened.database, {
      baseSha: "7654321",
      headSha: "def5678",
      now: "2026-07-13T10:10:00Z",
      repository: "owner/repo",
      workRef: { id: "issue-1", kind: "issue" },
    });
    await createAuthorizedIntent(opened.database, updateIntent("update-intent"));
    await commitRepositoryBranchUpdate(opened.database, {
      baseSha: "7654321",
      headSha: "fedcba9",
      now: "2026-07-13T10:11:00Z",
      receipt: {
        applied_at: "2026-07-13T10:11:00Z",
        intent_id: "update-intent",
        provider_request_id: "REQ-UPDATE",
        response_payload_hash: "sha256:update-response",
        result: "updated",
        result_revision: "fedcba9",
      },
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(opened.sqlite.prepare("select head_sha, base_sha from repository_links").get()).toEqual({
      base_sha: "7654321",
      head_sha: "fedcba9",
    });
    expect(opened.sqlite.prepare("select base_sha from workspace_checkouts").get()).toEqual({
      base_sha: "7654321",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "independent_verification_after_base_update_required",
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from repository_merge_queue_entries").get(),
    ).toEqual({ count: 0 });
    await opened.close();
  });

  it("links a failed merge to a repair SystemJob and returns the issue to In Progress", async () => {
    const opened = await fixture();
    await beginMergeQueueLanding(opened.database, {
      baseSha: "abc1234",
      headSha: "def5678",
      now: "2026-07-13T10:10:00Z",
      repository: "owner/repo",
      workRef: { id: "issue-1", kind: "issue" },
    });
    await createAuthorizedIntent(opened.database, authorizedIntent("merge-intent"));
    await commitMergeQueueLanding(opened.database, {
      mergeSha: "fedcba9",
      now: "2026-07-13T10:11:00Z",
      receipt: {
        applied_at: "2026-07-13T10:11:00Z",
        intent_id: "merge-intent",
        provider_request_id: "REQ-MERGE",
        response_payload_hash: "sha256:merge-response",
        result: "merged",
        result_revision: "fedcba9",
      },
      retryDueAt: "2026-07-13T10:11:30Z",
      workRef: { id: "issue-1", kind: "issue" },
    });
    opened.sqlite.prepare("update claims set mode = 'Ready', retry_due_at = null").run();
    await createAuthorizedIntent(opened.database, trackerInProgressIntent("repair-lane-intent"));
    await commitPostMergeRepairCycle(opened.database, {
      acceptanceCriteria: ["Restore passing post-merge checks"],
      configSnapshotId: "config-1",
      goal: "Repair failed merge fedcba9",
      now: "2026-07-13T10:12:00Z",
      receipt: {
        applied_at: "2026-07-13T10:12:00Z",
        intent_id: "repair-lane-intent",
        provider_request_id: "REQ-IN-PROGRESS",
        response_payload_hash: "sha256:repair-lane-response",
        result: "updated",
        result_revision: "provider-revision-2",
      },
      repairJobId: "repair-job-1",
      repository: "owner/repo",
      transitionId: "transition-repair",
      workRef: { id: "issue-1", kind: "issue" },
      workspacePath: "/work/_system/repair-repair-job-1",
    });
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "provider-revision-2",
      state: "In Progress",
    });
    expect(
      opened.sqlite
        .prepare("select kind, parent_work_ref_kind, parent_work_ref_id, status from system_jobs")
        .get(),
    ).toEqual({
      kind: "repair",
      parent_work_ref_id: "issue-1",
      parent_work_ref_kind: "issue",
      status: "queued",
    });
    expect(
      opened.sqlite
        .prepare(
          "select work_ref_kind, work_ref_id, mode, reason from claims order by work_ref_kind",
        )
        .all(),
    ).toEqual([
      {
        mode: "AwaitingHuman",
        reason: "repair_in_progress:repair-job-1",
        work_ref_id: "issue-1",
        work_ref_kind: "issue",
      },
      {
        mode: "Ready",
        reason: "system_job_dispatch_required",
        work_ref_id: "repair-job-1",
        work_ref_kind: "system_job",
      },
    ]);
    await opened.close();
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-merge-queue-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  seed(opened.sqlite);
  return opened;
}

function seed(sqlite: import("better-sqlite3").Database): void {
  sqlite
    .prepare(
      `insert into service_runs (
        id, service_version, host_id, started_at, status, start_reason
      ) values ('run-1', 'test', 'host-1', 't0', 'ready', 'test')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into stage_transitions (
        id, work_ref_kind, work_ref_id, from_stage, to_stage, reason,
        attempt_id, confirmed_external_revision, entered_at, timestamp_source
      ) values (
        'transition-review', 'issue', 'issue-1', 'In Progress', 'Review', 'publication.verified',
        null, 'provider-revision-1', '2026-07-13T10:02:00Z', 'receipt'
      )`,
    )
    .run();
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  sqlite
    .prepare(
      `insert into issues (
        id, identifier, title, description, acceptance_criteria_json, state, labels_json,
        priority, blocked_by_json, assignee_id, repo_owner, repo_name, url,
        provider_revision, created_at, updated_at
      ) values (
        'issue-1', 'ORG-1', 'Issue', 'Description', '[]', 'Review', '[]', 1, '[]',
        null, 'owner', 'repo', 'https://github.com/owner/repo/issues/1',
        'provider-revision-1', 't0', 't1'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null, 'Review',
        'merge_queue_required')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/work/issue-1',
        'config-1', 'standard', 'model', 'medium', '[]', 'standard',
        't0', 't1', 'closed', 'result-1'
      )`,
    )
    .run();
  sqlite
    .prepare(
      "insert into terminal_results values ('result-1', 'attempt-1', 'implementation', 'implementation_outcome', '{}', 't1')",
    )
    .run();
  sqlite
    .prepare(
      `insert into verification_records values (
        'verification-1', 'issue', 'issue-1', 'attempt-1', 'config-1', 'def5678',
        'sha256:command', 't1', 't2', 0, 'passed', null, null, 'sha256:environment'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into review_sets values (
        'review-set-1', 'issue', 'issue-1', 'def5678', 'abc1234', 'sha256:patch',
        '["integrative_review"]', '[]', 'verification-1', '[]', '[]', '[]',
        null, null, 'approve', 't3'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into repository_links values (
        'link-1', 'issue', 'issue-1', 1, 'primary', 'owner', 'repo',
        'symphony/issue-1', 42, 'https://github.com/owner/repo/pull/42',
        'def5678', 'main', 'abc1234', 'open', 't2', 't2'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into workspace_checkouts values (
        'issue', 'issue-1', '/work/issue-1', 'owner/repo', 'abc1234',
        'trusted_repository_adapter', 'symphony/issue-1', 't0', 'main'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into operators values (
        'operator-1', 'subject-1', '["merge_queue.write"]', 'maintainer', 'active', 1, 't0', 't0'
      )`,
    )
    .run();
}

function authorizedIntent(id: string) {
  const authorization = {
    action: "repository.merge_pull_request",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy" as const,
    attempt_role: "implementation" as const,
    authorized_at: "2026-07-13T10:10:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["merge_queue.review_set_approved", "merge_queue.operator_approved"],
    expires_at: "2026-07-13T10:20:00Z",
    id: "merge-authorization",
    idempotency_key: id,
    intent_id: id,
    observed_state_ref: "repository:owner/repo:head:def5678:base:abc1234",
    operator_capability: null,
    scope: "work" as const,
    service_run_id: "run-1",
    target: "owner/repo:issue:issue-1",
    target_revision: "def5678",
    work_ref: { issue_id: "issue-1" },
  };
  return {
    authorization,
    intent: {
      action: authorization.action,
      attempt_id: "attempt-1",
      authorization_id: authorization.id,
      created_at: authorization.authorized_at,
      id,
      idempotency_key: id,
      request_payload_hash: "sha256:merge-payload",
      scope: "work" as const,
      service_run_id: "run-1",
      status: "pending" as const,
      target: authorization.target,
      target_revision: authorization.target_revision,
      updated_at: authorization.authorized_at,
      work_ref: { issue_id: "issue-1" },
    },
  };
}

function trackerIntent(id: string) {
  const authorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy" as const,
    attempt_role: "implementation" as const,
    authorized_at: "2026-07-13T10:11:30Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["merge_queue.post_merge_checks_passed"],
    expires_at: "2026-07-13T10:20:00Z",
    id: "done-authorization",
    idempotency_key: id,
    intent_id: id,
    observed_state_ref: "tracker:issue-1:provider-revision-1",
    operator_capability: null,
    scope: "work" as const,
    service_run_id: "run-1",
    target: "issue-1",
    target_revision: "provider-revision-1",
    work_ref: { issue_id: "issue-1" },
  };
  return {
    authorization,
    intent: {
      action: authorization.action,
      attempt_id: "attempt-1",
      authorization_id: authorization.id,
      created_at: authorization.authorized_at,
      id,
      idempotency_key: id,
      request_payload_hash: "sha256:done-payload",
      scope: "work" as const,
      service_run_id: "run-1",
      status: "pending" as const,
      target: authorization.target,
      target_revision: authorization.target_revision,
      updated_at: authorization.authorized_at,
      work_ref: { issue_id: "issue-1" },
    },
  };
}

function updateIntent(id: string) {
  const authorization = {
    action: "repository.update_branch",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy" as const,
    attempt_role: "implementation" as const,
    authorized_at: "2026-07-13T10:10:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["merge_queue.base_advanced"],
    expires_at: "2026-07-13T10:20:00Z",
    id: "update-authorization",
    idempotency_key: id,
    intent_id: id,
    observed_state_ref: "repository:owner/repo:head:def5678:base:7654321",
    operator_capability: null,
    scope: "work" as const,
    service_run_id: "run-1",
    target: "owner/repo:issue:issue-1",
    target_revision: "def5678",
    work_ref: { issue_id: "issue-1" },
  };
  return {
    authorization,
    intent: {
      action: authorization.action,
      attempt_id: "attempt-1",
      authorization_id: authorization.id,
      created_at: authorization.authorized_at,
      id,
      idempotency_key: id,
      request_payload_hash: "sha256:update-payload",
      scope: "work" as const,
      service_run_id: "run-1",
      status: "pending" as const,
      target: authorization.target,
      target_revision: authorization.target_revision,
      updated_at: authorization.authorized_at,
      work_ref: { issue_id: "issue-1" },
    },
  };
}

function trackerInProgressIntent(id: string) {
  const candidate = trackerIntent(id);
  candidate.authorization.id = "repair-lane-authorization";
  candidate.authorization.decision_rule_ids = ["merge_queue.post_merge_failed"];
  candidate.intent.authorization_id = candidate.authorization.id;
  candidate.intent.request_payload_hash = "sha256:repair-lane-payload";
  return candidate;
}
