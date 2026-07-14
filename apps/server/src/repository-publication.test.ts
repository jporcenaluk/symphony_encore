import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RepositoryHostingAdapter, TrackerAdapter } from "@symphony/adapters";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  loadIssue,
  loadPendingRepositoryPublication,
  loadSystemJob,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeRepositoryPublication,
  executeSynthesisRepositoryPublication,
} from "./repository-publication.js";

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

  it("publishes a synthesis proposal as an ordinary SystemJob PR without tracker mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-publication-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    const proposal = seedSynthesis(opened.sqlite);
    const target = await loadPendingRepositoryPublication(opened.database, {
      id: "synthesis-1",
      kind: "system_job",
    });
    const job = await loadSystemJob(opened.database, "synthesis-1");
    if (!target || job?.kind !== "synthesis") throw new Error("synthesis fixture invalid");
    const repository: RepositoryHostingAdapter = {
      createRepairPullRequest: vi.fn(),
      ensurePullRequest: vi.fn(
        async (_workRef, headSha, baseRef, body, authority, systemJobKind, title) => {
          expect({ baseRef, systemJobKind, title }).toEqual({
            baseRef: "main",
            systemJobKind: "synthesis",
            title: "Improve workflow rules",
          });
          expect(body).toContain("Cited lessons: lesson-1");
          expect(authority.authorization.attempt_role).toBe("synthesis");
          return {
            mutation: mutation("REQ-SYNTHESIS-PR", "created", headSha),
            number: 43,
            url: "https://github.com/owner/repo/pull/43",
          };
        },
      ),
      fetchPostMergeStatus: vi.fn(),
      fetchPullRequestSnapshot: vi.fn(),
      mergePullRequest: vi.fn(),
      publishBranch: vi.fn(
        async (_workRef, workspace, expectedBaseSha, authority, systemJobKind) => {
          expect({ expectedBaseSha, systemJobKind, workspace }).toEqual({
            expectedBaseSha: "abc1234",
            systemJobKind: "synthesis",
            workspace: "/work/synthesis-1",
          });
          expect(authority.authorization.attempt_role).toBe("synthesis");
          return {
            branch: "symphony/system-synthesis-deadbeefdeadbeef",
            headSha: "def5678",
            mutation: mutation("REQ-SYNTHESIS-PUBLISH", "published", "def5678"),
          };
        },
      ),
      updateBranch: vi.fn(),
    };

    await executeSynthesisRepositoryPublication({
      database: opened.database,
      expiresAt: "2026-07-13T10:20:00Z",
      job,
      newId: (() => {
        let id = 0;
        return () => `synthesis-publication-${++id}`;
      })(),
      now: (() => {
        let minute = 3;
        return () => new Date(Date.UTC(2026, 6, 13, 10, minute++)).toISOString();
      })(),
      proposal,
      readWorkspaceRevision: vi.fn(async () => "def5678"),
      repository,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      serviceRunId: "run-1",
      target,
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "pull_request_hygiene_required",
    });
    expect(
      opened.sqlite.prepare("select kind, branch, pull_request_number from repository_links").get(),
    ).toEqual({
      branch: "symphony/system-synthesis-deadbeefdeadbeef",
      kind: "primary",
      pull_request_number: 43,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from side_effect_receipts").get(),
    ).toEqual({ count: 2 });
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

function seedSynthesis(sqlite: OpenedDatabase["sqlite"]) {
  const proposal = {
    branch: "symphony/system-synthesis-local",
    cited_lesson_ids: ["lesson-1"],
    decision: "propose_changes" as const,
    evidence: [{ kind: "commit" as const, sha: "def5678" }],
    handoff: {
      acceptance_criteria: ["cite lessons"],
      commands: [{ command: "make verify-fast", exit_code: 0 }],
      decisions_fixed: [],
      files_changed: ["WORKFLOW.md"],
      goal: "Synthesize lessons",
      open_items: [],
      revision: "def5678",
    },
    pull_request: { base_ref: "main", title: "Improve workflow rules" },
    repository_revision: "def5678",
    rule_changes: [
      {
        action: "add" as const,
        lesson_ids: ["lesson-1"],
        rationale: "Prevent recurrence",
        rule_id: "rule-new",
        text: "Require current-head verification",
      },
    ],
  };
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
      `insert into system_jobs (
        id, kind, repository, workspace_path, goal, acceptance_criteria_json,
        config_snapshot_id, status, created_at
      ) values (
        'synthesis-1', 'synthesis', 'owner/repo', '/work/synthesis-1',
        'Synthesize lessons', '["cite lessons"]', 'config-1', 'review', 't0'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into terminal_results (
        id, attempt_id, role, result_kind, payload_json, created_at
      ) values ('result-synthesis', 'attempt-synthesis', 'synthesis',
        'synthesis_result', ?, 't1')`,
    )
    .run(JSON.stringify(proposal));
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id
      ) values (
        'attempt-synthesis', 'system_job', 'synthesis-1', 'synthesis', 1,
        '/work/synthesis-1', 'config-1', 'deep', 'model', 'high', '[]', 'standard',
        't0', 't1', 'closed', 'result-synthesis'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into workspace_checkouts (
        work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
        checkout_method, local_branch, created_at, base_ref
      ) values (
        'system_job', 'synthesis-1', '/work/synthesis-1', 'owner/repo', 'abc1234',
        'trusted_repository_adapter', 'symphony/system-synthesis-local', 't0', 'main'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into verification_records (
        id, work_ref_kind, work_ref_id, attempt_id, config_snapshot_id, target_revision,
        command_hash, started_at, ended_at, exit_code, result, environment_policy_hash
      ) values (
        'verification-synthesis', 'system_job', 'synthesis-1', 'attempt-synthesis',
        'config-1', 'def5678', 'sha256:command', 't1', 't2', 0, 'passed',
        'sha256:environment'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at, expires_at,
        origin_stage, reason
      ) values (
        'system_job', 'synthesis-1', 'run-1', 'Ready', 't0', 't2', null,
        'review', 'pull_request_required'
      )`,
    )
    .run();
  return proposal;
}
