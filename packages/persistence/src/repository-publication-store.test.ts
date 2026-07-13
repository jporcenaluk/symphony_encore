import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SideEffectReceipt } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import {
  commitRepositoryLinkAndReviewLane,
  loadPendingRepositoryPublication,
} from "./repository-publication-store.js";
import { createAuthorizedIntent } from "./side-effect-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("repository publication persistence", () => {
  it("loads the verified checkout and atomically commits the PR link, Review lane, and hygiene route", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-publication-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    seed(opened.sqlite);

    await expect(
      loadPendingRepositoryPublication(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      attemptId: "attempt-1",
      baseRef: "main",
      baseSha: "abc1234",
      configSnapshotId: "config-1",
      cycle: 1,
      localBranch: "symphony/issue-1",
      repository: "owner/repo",
      targetSha: "def5678",
      verificationRecordId: "verification-1",
      workspacePath: "/work/issue-1",
    });

    await createAuthorizedIntent(opened.database, authorizedIntent("tracker-intent"));
    const receipt: SideEffectReceipt = {
      applied_at: "2026-07-13T10:04:00Z",
      intent_id: "tracker-intent",
      provider_request_id: "REQ-LANE",
      response_payload_hash: "sha256:lane-response",
      result: "updated",
      result_revision: "provider-revision-2",
    };
    await commitRepositoryLinkAndReviewLane(opened.database, {
      expectedReadyReason: "pull_request_required",
      link: {
        base_ref: "main",
        base_sha: "abc1234",
        branch: "symphony/issue-1",
        created_at: "2026-07-13T10:04:00Z",
        cycle: 1,
        head_sha: "def5678",
        id: "repository-link-1",
        kind: "primary",
        pull_request_number: 42,
        pull_request_url: "https://github.com/owner/repo/pull/42",
        repo_name: "repo",
        repo_owner: "owner",
        state: "open",
        updated_at: "2026-07-13T10:04:00Z",
        work_ref: { issue_id: "issue-1" },
      },
      nextReadyReason: "pull_request_hygiene_required",
      receipt,
      transitionId: "transition-review",
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "pull_request_hygiene_required",
    });
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "provider-revision-2",
      state: "Review",
    });
    expect(
      opened.sqlite
        .prepare(
          "select cycle, branch, pull_request_number, head_sha, base_ref, base_sha from repository_links",
        )
        .get(),
    ).toEqual({
      base_ref: "main",
      base_sha: "abc1234",
      branch: "symphony/issue-1",
      cycle: 1,
      head_sha: "def5678",
      pull_request_number: 42,
    });
    await opened.close();
  });
});

function authorizedIntent(id: string) {
  const authorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy" as const,
    attempt_role: "implementation" as const,
    authorized_at: "2026-07-13T10:03:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["publication.verified", "lane.in_progress_to_review"],
    expires_at: "2026-07-13T10:08:00Z",
    id: "tracker-authorization",
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
      request_payload_hash: "sha256:lane-payload",
      scope: "work" as const,
      service_run_id: "run-1",
      status: "pending" as const,
      target: "issue-1",
      target_revision: "provider-revision-1",
      updated_at: authorization.authorized_at,
      work_ref: { issue_id: "issue-1" },
    },
  };
}

function seed(sqlite: import("better-sqlite3").Database): void {
  sqlite
    .prepare(
      `insert into service_runs (
        id, service_version, host_id, started_at, status, start_reason
      ) values ('run-1', 'test', 'host-1', '2026-07-13T10:00:00Z', 'ready', 'test')`,
    )
    .run();
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
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
      `insert into terminal_results values (
        'result-1', 'attempt-1', 'implementation', 'implementation_outcome', '{}', 't1'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into issues (
        id, identifier, title, description, acceptance_criteria_json, state,
        labels_json, priority, blocked_by_json, assignee_id, repo_owner, repo_name,
        url, provider_revision, created_at, updated_at
      ) values (
        'issue-1', 'owner/repo#1', 'Publish verified work', '', '[]', 'In Progress',
        '[]', null, '[]', null, 'owner', 'repo',
        'https://github.com/owner/repo/issues/1', 'provider-revision-1',
        '2026-07-13T10:00:00Z', '2026-07-13T10:01:00Z'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into workspace_checkouts (
        work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
        checkout_method, local_branch, created_at, base_ref
      ) values (
        'issue', 'issue-1', '/work/issue-1', 'owner/repo', 'abc1234',
        'trusted_repository_adapter', 'symphony/issue-1', 't0', 'main'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into verification_records (
        id, work_ref_kind, work_ref_id, attempt_id, config_snapshot_id, target_revision,
        command_hash, started_at, ended_at, exit_code, result, environment_policy_hash
      ) values (
        'verification-1', 'issue', 'issue-1', 'attempt-1', 'config-1', 'def5678',
        'sha256:command', 't1', 't2', 0, 'passed', 'sha256:environment'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at, expires_at,
        origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Ready', 't0', 't2', null,
        'In Progress', 'pull_request_required'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into stage_transitions (
        id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, attempt_id,
        confirmed_external_revision, entered_at, exited_at, duration_ms, timestamp_source
      ) values (
        'transition-in-progress', 'issue', 'issue-1', 'Todo', 'In Progress',
        'dispatch.eligible', 'attempt-1', 'provider-revision-1',
        '2026-07-13T10:01:00Z', null, null, 'receipt'
      )`,
    )
    .run();
}
