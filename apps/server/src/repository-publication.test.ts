import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RepositoryHostingAdapter, TrackerAdapter } from "@symphony/adapters";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  loadIssue,
  loadPendingRepositoryPublication,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRepositoryPublication } from "./repository-publication.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("verified repository publication", () => {
  it("persists every authorization before its call and finishes in PR hygiene", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-publication-executor-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    seed(opened.sqlite);
    const target = await loadPendingRepositoryPublication(opened.database, {
      id: "issue-1",
      kind: "issue",
    });
    const stored = await loadIssue(opened.database, "issue-1");
    if (!target || !stored) throw new Error("publication fixture invalid");
    const observedStatuses: string[][] = [];
    const observeIntents = () => {
      observedStatuses.push(
        opened.sqlite
          .prepare(
            "select action || ':' || status as value from side_effect_intents order by rowid",
          )
          .all()
          .map((row) => (row as { value: string }).value),
      );
    };
    const repository: RepositoryHostingAdapter = {
      createRepairPullRequest: vi.fn(),
      ensurePullRequest: vi.fn(async (_workRef, headSha, baseRef, _body, authority) => {
        observeIntents();
        expect(authority.authorization.action).toBe("repository.ensure_pull_request");
        expect(baseRef).toBe("main");
        return {
          mutation: mutation("REQ-PR", "created", headSha),
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
        };
      }),
      fetchPostMergeStatus: vi.fn(),
      fetchPullRequestSnapshot: vi.fn(),
      mergePullRequest: vi.fn(),
      publishBranch: vi.fn(async (_workRef, workspace, expectedBaseSha, authority) => {
        observeIntents();
        expect(authority.authorization.action).toBe("repository.publish_branch");
        expect(workspace).toBe("/work/issue-1");
        expect(expectedBaseSha).toBe("abc1234");
        return {
          branch: "symphony/issue-1",
          headSha: "def5678",
          mutation: mutation("REQ-PUBLISH", "published", "def5678"),
        };
      }),
      updateBranch: vi.fn(),
    };
    const tracker: TrackerAdapter = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(async (id, lane, reason, authority) => {
        observeIntents();
        expect({ id, lane, reason }).toEqual({
          id: "issue-1",
          lane: "Review",
          reason: "publication.verified",
        });
        expect(authority.authorization.observed_state_ref).toBe(
          "tracker:issue-1:provider-revision-1",
        );
        return mutation("REQ-LANE", "updated", "provider-revision-2");
      }),
    };

    await executeRepositoryPublication({
      database: opened.database,
      expiresAt: "2026-07-13T10:20:00Z",
      issue: stored.issue,
      newId: (() => {
        let id = 0;
        return () => `publication-id-${++id}`;
      })(),
      now: (() => {
        let minute = 3;
        return () => new Date(Date.UTC(2026, 6, 13, 10, minute++)).toISOString();
      })(),
      providerRevision: stored.providerRevision,
      readWorkspaceRevision: vi.fn(async () => "def5678"),
      repository,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      serviceRunId: "run-1",
      target,
      tracker,
    });

    expect(observedStatuses).toEqual([
      ["repository.publish_branch:applying"],
      ["repository.publish_branch:applied", "repository.ensure_pull_request:applying"],
      [
        "repository.publish_branch:applied",
        "repository.ensure_pull_request:applied",
        "tracker.update_lane:applying",
      ],
    ]);
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "pull_request_hygiene_required",
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_receipts").get(),
    ).toEqual({
      count: 3,
    });
    expect(opened.sqlite.prepare("select pull_request_number from repository_links").get()).toEqual(
      {
        pull_request_number: 42,
      },
    );
    await opened.close();
  });
});

function mutation(providerRequestId: string, result: string, resultRevision: string) {
  return {
    providerRequestId,
    responsePayloadHash: `sha256:${providerRequestId.toLocaleLowerCase("en-US")}`,
    result,
    resultRevision,
  };
}

function seed(sqlite: OpenedDatabase["sqlite"]): void {
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
      `insert into terminal_results values (
        'result-1', 'attempt-1', 'implementation', 'implementation_outcome', '{}', 't1'
      )`,
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
