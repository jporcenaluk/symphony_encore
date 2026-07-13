import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentAdapter,
  type AgentLaunchRequest,
  type AgentPreflightRequest,
  type AgentSession,
  issueWorkspacePath,
  type RepositoryHostingAdapter,
  systemJobWorkspacePath,
  type WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import { type AgentAdapterManifest, type Issue, PlanSchema } from "@symphony/contracts";
import { applyMigrations, observeIssue, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionScheduler } from "./production-scheduler.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const effectiveConfig = {
  "agent.command": "codex app-server",
  "agent.max_concurrent": 1,
  "agent.max_failure_retries": 2,
  "agent.max_plan_revisions": 2,
  "agent.max_rework_cycles": 2,
  "agent.max_turns": 8,
  "agent.max_retry_backoff_ms": 30_000,
  "agent.required_skills": [],
  "agent.stall_timeout_ms": 300_000,
  "budget.estimate_tokens_by_profile": {
    deep: 300_000,
    economy: 100_000,
    standard: 200_000,
  },
  "budget.history_min_samples": 10,
  "budget.history_window_samples": 50,
  "budget.per_attempt_tokens": 400_000,
  "budget.per_attempt_usd": 2.5,
  "budget.per_issue_tokens": 2_000_000,
  "budget.per_issue_usd": 7.5,
  "budget.rolling_24h_tokens": 10_000_000,
  "budget.rolling_24h_usd": 40.5,
  "compute.enabled_profiles": ["economy", "standard", "deep"],
  "compute.risk_floor_rules": [],
  "compute.route_profiles": {
    adjudication: "deep",
    implementation: { high_risk: "deep", standard: "standard", trivial: "economy" },
    integrative_review: "standard",
    plan_review: "economy",
    specialist_review: "deep",
    synthesis: "deep",
  },
  "class.risk_paths": [],
  "class.trivial_max_changed_lines": 25,
  "class.trivial_patterns": [],
  "env.allowlist": [],
  "hooks.after_create": null,
  "hooks.before_remove": null,
  "hooks.before_run": null,
  "hooks.timeout_ms": 60_000,
  "learning.interval_issues": 25,
  "learning.max_prompt_tokens": 4_000,
  "learning.max_rules": 25,
  "learning.rule_decay_issues": 100,
  "persistence.lease_ttl_ms": 120_000,
  "polling.interval_ms": 30_000,
  "review.accepted_check_conclusions": ["success", "neutral", "skipped"],
  "review.quiet_period_ms": 0,
  "review.required_checks": [],
  "review.settle_timeout_ms": 1_800_000,
  "review.snapshot_timeout_ms": 30_000,
  "review.specialists": [
    {
      concerns: ["security"],
      excluded_context: ["builder_narrative"],
      name: "systems_security",
      profile: "deep",
      required_evidence: ["diff", "checks", "acceptance_criteria"],
      trigger_rules: ["risk.security_auth"],
    },
  ],
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
  "workspace.verify_command": "make verify-fast",
  "workspace.verify_none_reason": null,
};

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-v2:test",
  capabilities: ["terminal_result", "submit_plan", "skills"],
  price_table: null,
  profiles: {
    deep: { model: "gpt-test", reasoning_effort: "high" },
    economy: { model: "gpt-test", reasoning_effort: "low" },
    standard: { model: "gpt-test", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:protocol" },
};

const candidate: Issue = {
  acceptance_criteria: ["The scheduler closes the consumed attempt"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Dispatch this issue through the production scheduler.",
  id: "issue-1",
  identifier: "ORG-9",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "Todo",
  title: "Run the production scheduler lifecycle",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/9",
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
      prompt: "Issue: {{ issue.title }}",
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
        prompt: "Issue: {{ issue.title }}",
        serviceRunId: "run-1",
        snapshot: { effectiveConfig: {} } as never,
        tracker: {} as never,
      }),
    ).toThrow("scheduler.config:env.allowlist");
  });

  it("dispatches an eligible candidate through verification and integrative review", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-production-dispatch-"));
    directories.push(directory);
    const workspaceRoot = path.join(directory, "workspaces");
    await mkdir(workspaceRoot);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
        `insert into operators (
          id, auth_subject, capabilities_json, tracker_login, status,
          version, created_at, updated_at
        ) values (
          'operator-1', 'subject-1', '["merge_queue.write"]', 'maintainer',
          'active', 1, 't0', 't0'
        )`,
      )
      .run();
    const outcome = {
      actions_requested: [],
      confusions: [],
      evidence: [{ command: "make verify-fast", exit_code: 0, kind: "command", result: "passed" }],
      handoff: {
        acceptance_criteria: candidate.acceptance_criteria,
        commands: [],
        decisions_fixed: [],
        files_changed: [],
        goal: candidate.title,
        open_items: candidate.acceptance_criteria,
        revision: "abc1234",
      },
      status: "completed",
      summary: "Implementation is ready for independent verification.",
      verification: { command: "make verify-fast", exit_code: 0, result: "passed" },
    };
    let repositoryBase = "abc1234";
    let repositoryHead = "abc1234";
    const agent: AgentAdapter = {
      launch: vi.fn(async (request: AgentLaunchRequest) => {
        const isReview = request.preflight.role === "integrative_review";
        const submittedPlan = {
          acceptance_criteria: [
            {
              criterion_id: "criterion-1",
              criterion_text: candidate.acceptance_criteria[0],
              planned_evidence: "The production scheduler integration test",
            },
          ],
          approach: "Exercise the production scheduling boundary.",
          approved_by_attempt_id: null,
          created_at: "2026-07-13T10:00:03.500Z",
          created_by_attempt_id: request.attemptId,
          estimated_changed_lines: 10,
          estimated_files: 1,
          id: "plan-1",
          proposed_paths: ["apps/server/src/production-scheduler.ts"],
          revision: 1,
          risk_facts: [],
          status: "draft" as const,
          validated_at: null,
          verification_commands: ["make verify-fast"],
          work_ref: { issue_id: candidate.id },
        };
        const planDecision = isReview ? undefined : request.onPlanSubmitted?.(submittedPlan);
        const session: AgentSession = {
          cancel: vi.fn(async () => undefined),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                attempt_id: request.attemptId,
                event: "session_started" as const,
                model: "gpt-test",
                reasoning_effort: "medium",
                session_id: "thread-1-turn-1",
                thread_id: "thread-1",
                timestamp: "2026-07-13T10:00:03.000Z",
                turn_id: "turn-1",
              };
              if (isReview) {
                yield {
                  attempt_id: request.attemptId,
                  event: "terminal_result_reported" as const,
                  result: {
                    decision: "approve",
                    evidence: [{ kind: "commit", sha: repositoryHead }],
                    findings: [],
                    target_sha: repositoryHead,
                  },
                  session_id: "thread-1-turn-1",
                  timestamp: "2026-07-13T10:00:04.000Z",
                };
                yield {
                  attempt_id: request.attemptId,
                  event: "turn_completed" as const,
                  provider_reason: "completed",
                  session_id: "thread-1-turn-1",
                  timestamp: "2026-07-13T10:00:05.000Z",
                };
                return;
              }
              const decision = await planDecision;
              if (!decision?.accepted) throw new Error("production Plan gate rejected valid Plan");
              yield {
                attempt_id: request.attemptId,
                event: "plan_reported" as const,
                plan: submittedPlan,
                session_id: "thread-1-turn-1",
                timestamp: "2026-07-13T10:00:03.500Z",
              };
              yield {
                attempt_id: request.attemptId,
                event: "terminal_result_reported" as const,
                result: outcome,
                session_id: "thread-1-turn-1",
                timestamp: "2026-07-13T10:00:04.000Z",
              };
              yield {
                attempt_id: request.attemptId,
                event: "turn_completed" as const,
                provider_reason: "completed",
                session_id: "thread-1-turn-1",
                timestamp: "2026-07-13T10:00:05.000Z",
              };
            },
          },
          processGroupId: 4320,
          processId: 4321,
          waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
        };
        return session;
      }),
      manifest: vi.fn(async () => manifest),
      preflight: vi.fn(async (request: AgentPreflightRequest) => ({
        adapterVersion: manifest.adapter_version,
        manifest,
        protocolSchemaHash: manifest.protocol.schema_hash,
        resolvedSkills: request.requiredSkills,
        role: request.role,
        submitPlanSchema: request.submitPlanSchema ?? null,
        terminalResultSchema: request.terminalResultSchema,
      })),
    };
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      async populateIssueWorkspace(input) {
        const workspacePath = issueWorkspacePath(input.workspaceRoot, input.identifier);
        await mkdir(workspacePath);
        return {
          baseRef: "main",
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter",
          createdAt: "2026-07-13T10:00:01.000Z",
          localBranch: "symphony/org-9",
          repository: input.repository,
          workspacePath,
        };
      },
    };
    let trackerState = candidate.state;
    let trackerRevision = 7;
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({
        cursor: null,
        hasMore: false,
        items: [{ ...candidate, state: trackerState }],
      })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(async () => ({
        cursor: null,
        hasMore: false,
        items: [{ id: candidate.id, revision: `revision-${trackerRevision}`, state: trackerState }],
      })),
      updateIssueLane: vi.fn(async (_id: string, lane: string) => {
        trackerState = lane as Issue["state"];
        trackerRevision += 1;
        return {
          providerRequestId: `request-${trackerRevision}`,
          responsePayloadHash: `sha256:receipt-${trackerRevision}`,
          result: "updated",
          resultRevision: `revision-${trackerRevision}`,
        };
      }),
    };
    const repositoryHostingAdapter: RepositoryHostingAdapter = {
      createRepairPullRequest: vi.fn(),
      ensurePullRequest: vi.fn(async (_workRef, headSha) => ({
        mutation: {
          providerRequestId: "request-pr",
          responsePayloadHash: "sha256:pr",
          result: "created",
          resultRevision: headSha,
        },
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      })),
      fetchPostMergeStatus: vi.fn(async () => ({
        base_ref: "main",
        checks: [],
        head_sha: "fedcba9",
        is_draft: false,
        mergeable: true,
        observed_base_sha: "fedcba9",
        post_merge_checks: [],
        pr_number: 42,
        pr_state: "merged" as const,
        pr_url: "https://github.com/owner/repo/pull/42",
        required_check_source: "configured" as const,
        review_decision: "none" as const,
        reviews: [],
        unresolved_threads: [],
      })),
      fetchPullRequestSnapshot: vi.fn(async () => ({
        base_ref: "main",
        checks: [],
        head_sha: repositoryHead,
        is_draft: false,
        mergeable: true,
        observed_base_sha: repositoryBase,
        post_merge_checks: [],
        pr_number: 42,
        pr_state: "open" as const,
        pr_url: "https://github.com/owner/repo/pull/42",
        required_check_source: "union" as const,
        review_decision: "approved" as const,
        reviews: [
          {
            author: "maintainer",
            commit_sha: repositoryHead,
            state: "approved",
            submitted_at: "2026-07-13T10:00:08.000Z",
          },
        ],
        unresolved_threads: [],
      })),
      mergePullRequest: vi.fn(async () => ({
        mergeSha: "fedcba9",
        mutation: {
          providerRequestId: "request-merge",
          responsePayloadHash: "sha256:merge",
          result: "merged",
          resultRevision: "fedcba9",
        },
      })),
      publishBranch: vi.fn(async () => ({
        branch: "symphony/org-9",
        headSha: "abc1234",
        mutation: {
          providerRequestId: "request-publish",
          responsePayloadHash: "sha256:publish",
          result: "published",
          resultRevision: "abc1234",
        },
      })),
      updateBranch: vi.fn(async (_workRef, expectedHeadSha, expectedBaseSha) => {
        expect(expectedHeadSha).toBe(repositoryHead);
        expect(expectedBaseSha).toBe(repositoryBase);
        repositoryHead = "def5678";
        return {
          branch: "symphony/org-9",
          headSha: repositoryHead,
          mutation: {
            providerRequestId: "request-update",
            responsePayloadHash: "sha256:update",
            result: "updated",
            resultRevision: repositoryHead,
          },
        };
      }),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const scheduler = createProductionScheduler({
      agent,
      database: opened.database,
      environment: {},
      logger,
      prompt: "Implement {{ issue.title }}.",
      repositoryAdapter,
      repositoryHostingAdapter,
      repositorySync: vi.fn(async (request) => request.expectedHeadSha),
      review: {
        collectEvidence: vi.fn(async (request) => ({
          baseSha: request.baseSha,
          changeClass: request.changeClass,
          changedFiles: ["apps/server/src/production-scheduler.ts"],
          changedLines: 12,
          diff: "diff --git a/apps/server/src/production-scheduler.ts b/apps/server/src/production-scheduler.ts",
          patchIdentity: "sha256:patch",
          repositoryDocs: [],
          targetSha: request.targetSha,
          verificationRecordId: request.verificationRecordId,
        })),
      },
      serviceRunId: "run-1",
      snapshot: {
        effectiveConfig: { ...effectiveConfig, "workspace.root": workspaceRoot },
        id: "config-1",
      } as never,
      tracker,
      verification: {
        execute: vi.fn(async () => ({
          commandHash: "sha256:command",
          endedAt: "2026-07-13T10:00:07.000Z",
          environmentPolicyHash: "sha256:environment",
          exitCode: 0,
          result: "passed" as const,
          startedAt: "2026-07-13T10:00:06.000Z",
          stderr: "",
          stdout: "all passed",
        })),
        readRevision: vi.fn(async () => repositoryHead),
      },
    });

    await scheduler.start();
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalled());
    expect(logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() => expect(agent.launch).toHaveBeenCalled(), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "independent_verification_required",
      }),
    );
    await scheduler.trigger();
    expect(logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "pull_request_required",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledTimes(2));
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "pull_request_hygiene_required",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledTimes(3));
    await scheduler.trigger();
    expect(logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "review_required",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledTimes(4));
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "review_coordination_required",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledTimes(5));
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "merge_queue_required",
      }),
    );
    repositoryBase = "7654321";
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "base_update_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "independent_verification_after_base_update_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "pull_request_hygiene_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "review_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "review_coordination_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "merge_queue_required",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "RetryQueued",
        reason: "post_merge_verification_required",
      }),
    );
    opened.sqlite.prepare("update claims set retry_due_at = '2000-01-01T00:00:00.000Z'").run();
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
        count: 0,
      }),
    );
    await scheduler.close();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(agent.launch).toHaveBeenCalledTimes(3);
    expect(tracker.updateIssueLane).toHaveBeenCalledWith(
      candidate.id,
      "In Progress",
      "dispatch.eligible",
      expect.any(Object),
    );
    expect(
      opened.sqlite.prepare("select role, status from attempts order by attempt_number").all(),
    ).toEqual([
      { role: "implementation", status: "closed" },
      { role: "integrative_review", status: "closed" },
      { role: "integrative_review", status: "closed" },
    ]);
    expect(opened.sqlite.prepare("select state from issues").get()).toEqual({ state: "Done" });
    expect(opened.sqlite.prepare("select state from repository_merge_queue_entries").get()).toEqual(
      { state: "completed" },
    );
    expect(repositoryHostingAdapter.mergePullRequest).toHaveBeenCalledWith(
      { issue_id: candidate.id },
      "def5678",
      "squash",
      expect.any(Object),
    );
    expect(
      opened.sqlite
        .prepare(
          "select target_revision, result from verification_records order by target_revision",
        )
        .all(),
    ).toEqual([
      { result: "passed", target_revision: "abc1234" },
      { result: "passed", target_revision: "def5678" },
    ]);
    expect(
      opened.sqlite
        .prepare(
          "select reviewer_role, target_sha, decision from review_records order by target_sha",
        )
        .all(),
    ).toEqual([
      { decision: "approve", reviewer_role: "integrative_review", target_sha: "abc1234" },
      { decision: "approve", reviewer_role: "integrative_review", target_sha: "def5678" },
    ]);
    expect(opened.sqlite.prepare("select pull_request_number from repository_links").get()).toEqual(
      {
        pull_request_number: 42,
      },
    );
    expect(opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "validated",
    });
    await expect(readFile(path.join(workspaceRoot, "ORG-9", "PLAN.md"), "utf8")).resolves.toContain(
      "Status: validated",
    );
    await opened.close();
  });

  it("dispatches a durable Plan-review Ready claim without a tracker candidate", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-production-plan-review-"));
    directories.push(directory);
    const workspaceRoot = path.join(directory, "workspaces");
    await mkdir(workspaceRoot);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
    const reviewIssue: Issue = { ...candidate, id: "review-issue", state: "In Progress" };
    await observeIssue(opened.database, {
      issue: reviewIssue,
      observedAt: "2026-07-13T10:00:00Z",
      providerRevision: "revision-8",
      transitionId: "baseline-review",
    });
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
          change_class, started_at, ended_at, status, terminal_result_id
        ) values (
          'builder-attempt', 'issue', 'review-issue', 'implementation', 1, ?,
          'config-1', 'deep', 'gpt-test', 'high', '[]', 'high_risk',
          't0', 't1', 'closed', 'builder-result'
        )`,
      )
      .run(issueWorkspacePath(workspaceRoot, reviewIssue.identifier));
    opened.sqlite
      .prepare(
        `insert into plans (
          id, work_ref_kind, work_ref_id, revision, status, approach,
          acceptance_criteria_json, proposed_paths_json, verification_commands_json,
          estimated_files, estimated_changed_lines, risk_facts_json,
          created_by_attempt_id, created_at, validated_at, approved_by_attempt_id
        ) values (
          'review-plan', 'issue', 'review-issue', 1, 'validated', 'Review the change',
          ?, '["apps/server/src/production-scheduler.ts"]', '["make verify-fast"]',
          1, 20, '["risk.security_auth"]', 'builder-attempt', 't0', 't1', null
        )`,
      )
      .run(
        JSON.stringify([
          {
            criterion_id: "criterion-1",
            criterion_text: reviewIssue.acceptance_criteria[0],
            planned_evidence: "Production scheduler Plan-review coverage",
          },
        ]),
      );
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values (
          'issue', 'review-issue', 'run-1', 'Ready', 't0', 't1', null,
          'In Progress', 'plan_review_required'
        )`,
      )
      .run();
    const agent: AgentAdapter = {
      launch: vi.fn(async (request: AgentLaunchRequest) => {
        const planReview = request.preflight.role === "plan_review";
        const sessionId = planReview ? "review-session" : "implementation-session";
        const session: AgentSession = {
          cancel: vi.fn(async () => undefined),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                attempt_id: request.attemptId,
                event: "session_started" as const,
                model: "gpt-test",
                reasoning_effort: planReview ? "low" : "high",
                session_id: sessionId,
                thread_id: planReview ? "review-thread" : "implementation-thread",
                timestamp: "2026-07-13T10:00:01Z",
                turn_id: planReview ? "review-turn" : "implementation-turn",
              };
              if (!planReview) {
                yield {
                  action_id: "action-1",
                  attempt_id: request.attemptId,
                  cwd: request.workspacePath,
                  event: "action_started" as const,
                  exit_code: null,
                  kind: "file_change",
                  output_ref: null,
                  result_status: null,
                  session_id: sessionId,
                  summary: "Implement approved Plan",
                  timestamp: "2026-07-13T10:00:02Z",
                };
              }
              yield {
                attempt_id: request.attemptId,
                event: "terminal_result_reported" as const,
                result: planReview
                  ? {
                      decision: "approve",
                      evidence: [{ kind: "file", path: "PLAN.md" }],
                      findings: [],
                      handoff: {
                        acceptance_criteria: reviewIssue.acceptance_criteria,
                        commands: [],
                        decisions_fixed: [],
                        files_changed: [],
                        goal: reviewIssue.title,
                        open_items: [],
                        revision: "abc1234",
                      },
                      plan_revision: 1,
                    }
                  : {
                      actions_requested: [],
                      confusions: [],
                      evidence: [],
                      handoff: {
                        acceptance_criteria: reviewIssue.acceptance_criteria,
                        commands: [],
                        decisions_fixed: [],
                        files_changed: [],
                        goal: reviewIssue.title,
                        open_items: reviewIssue.acceptance_criteria,
                        revision: "abc1234",
                      },
                      status: "needs_rework",
                      summary: "Continue implementation.",
                    },
                session_id: sessionId,
                timestamp: "2026-07-13T10:00:02Z",
              };
              yield {
                attempt_id: request.attemptId,
                event: "turn_completed" as const,
                provider_reason: "completed",
                session_id: sessionId,
                timestamp: "2026-07-13T10:00:03Z",
              };
            },
          },
          processGroupId: 6320,
          processId: 6321,
          waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
        };
        return session;
      }),
      manifest: vi.fn(async () => manifest),
      preflight: vi.fn(async (request: AgentPreflightRequest) => ({
        adapterVersion: manifest.adapter_version,
        manifest,
        protocolSchemaHash: manifest.protocol.schema_hash,
        resolvedSkills: request.requiredSkills,
        role: request.role,
        submitPlanSchema: request.submitPlanSchema ?? null,
        terminalResultSchema: request.terminalResultSchema,
      })),
    };
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      async populateIssueWorkspace(input) {
        const workspacePath = issueWorkspacePath(input.workspaceRoot, input.identifier);
        await mkdir(workspacePath);
        return {
          baseRef: "main",
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter",
          createdAt: "2026-07-13T10:00:00Z",
          localBranch: "symphony/org-9",
          repository: input.repository,
          workspacePath,
        };
      },
    };
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(),
    };
    const scheduler = createProductionScheduler({
      agent,
      database: opened.database,
      environment: {},
      prompt: "Implement {{ issue.title }}.",
      repositoryAdapter,
      serviceRunId: "run-1",
      snapshot: {
        effectiveConfig: { ...effectiveConfig, "workspace.root": workspaceRoot },
        id: "config-1",
      } as never,
      tracker,
    });

    await scheduler.start();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "implementation_after_plan_approval",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "implementation_rework",
      }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "AwaitingHuman",
        reason: "human_review",
      }),
    );
    await scheduler.close();

    expect(tracker.fetchCandidates).toHaveBeenCalledTimes(3);
    expect(agent.preflight).toHaveBeenCalledWith(expect.objectContaining({ role: "plan_review" }));
    expect(agent.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ role: "implementation", submitPlanSchema: PlanSchema }),
    );
    expect(agent.launch).toHaveBeenCalledTimes(3);
    expect(agent.launch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Resume from the factual handoff after implementation_rework: Continue implementation.",
        ),
      }),
    );
    expect(opened.sqlite.prepare("select status, approved_by_attempt_id from plans").get()).toEqual(
      {
        approved_by_attempt_id: expect.any(String),
        status: "approved",
      },
    );
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "AwaitingHuman",
      reason: "human_review",
    });
    expect(opened.sqlite.prepare("select origin_stage, reason from parked_work").get()).toEqual({
      origin_stage: "In Progress",
      reason: "human_review",
    });
    await opened.close();
  });

  it("routes a high-risk complete integrative record to its first triggered specialist", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-production-specialist-route-"));
    directories.push(directory);
    const workspaceRoot = path.join(directory, "workspaces");
    const workspacePath = path.join(workspaceRoot, "ORG-9");
    await mkdir(workspacePath, { recursive: true });
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
    const highRiskIssue: Issue = {
      ...candidate,
      labels: ["security"],
      state: "In Progress",
    };
    await observeIssue(opened.database, {
      issue: highRiskIssue,
      observedAt: "2026-07-13T10:00:00Z",
      providerRevision: "revision-8",
      transitionId: "baseline-specialist",
    });
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
          change_class, started_at, ended_at, status, terminal_result_id
        ) values
          ('implementation-1', 'issue', 'issue-1', 'implementation', 1, ?,
           'config-1', 'deep', 'gpt-test', 'high', '["risk.security_auth"]', 'high_risk',
           't0', 't1', 'closed', 'implementation-result-1'),
          ('integrative-1', 'issue', 'issue-1', 'integrative_review', 2, ?,
           'config-1', 'standard', 'gpt-test', 'medium', '[]', 'high_risk',
           't2', 't3', 'closed', 'integrative-result-1')`,
      )
      .run(workspacePath, workspacePath);
    opened.sqlite
      .prepare(
        `insert into plans (
          id, work_ref_kind, work_ref_id, revision, status, approach,
          acceptance_criteria_json, proposed_paths_json, verification_commands_json,
          estimated_files, estimated_changed_lines, risk_facts_json,
          created_by_attempt_id, created_at, validated_at, approved_by_attempt_id
        ) values (
          'plan-1', 'issue', 'issue-1', 1, 'approved', 'Secure the boundary',
          '[]', '["src/auth.ts"]', '["make verify-fast"]', 1, 12,
          '["risk.security_auth"]', 'implementation-1', 't0', 't1', 'implementation-1'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into verification_records (
          id, work_ref_kind, work_ref_id, attempt_id, config_snapshot_id, target_revision,
          command_hash, started_at, ended_at, exit_code, result, environment_policy_hash
        ) values (
          'verification-1', 'issue', 'issue-1', 'implementation-1', 'config-1', 'def5678',
          'sha256:command', 't1', 't2', 0, 'passed', 'sha256:environment'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into workspace_checkouts (
          work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
          checkout_method, local_branch, created_at, base_ref
        ) values (
          'issue', 'issue-1', ?, 'owner/repo', 'abc1234',
          'trusted_repository_adapter', 'symphony/org-9', 't0', 'main'
        )`,
      )
      .run(workspacePath);
    opened.sqlite
      .prepare(
        `insert into review_records (
          id, work_ref_kind, work_ref_id, attempt_id, reviewer_role, target_sha,
          target_base_sha, patch_identity, decision, findings_json, created_at
        ) values (
          'review-record-1', 'issue', 'issue-1', 'integrative-1', 'integrative_review',
          'def5678', 'abc1234', 'sha256:patch', 'approve', '[]', 't3'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values (
          'issue', 'issue-1', 'run-1', 'Ready', 't0', 't3', null,
          'In Progress', 'review_coordination_required'
        )`,
      )
      .run();
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(),
    };
    const agent = createSpecialistAgent();
    const scheduler = createProductionScheduler({
      agent,
      database: opened.database,
      environment: {},
      prompt: "Implement {{ issue.title }}.",
      review: {
        collectEvidence: vi.fn(async (request) => ({
          baseSha: request.baseSha,
          changeClass: request.changeClass,
          changedFiles: ["src/auth.ts"],
          changedLines: 12,
          diff: "diff --git a/src/auth.ts b/src/auth.ts",
          patchIdentity: "sha256:patch",
          repositoryDocs: [],
          targetSha: request.targetSha,
          verificationRecordId: request.verificationRecordId,
        })),
      },
      serviceRunId: "run-1",
      snapshot: {
        effectiveConfig: { ...effectiveConfig, "workspace.root": workspaceRoot },
        id: "config-1",
      } as never,
      tracker,
    });

    await scheduler.start();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "specialist_review_required:systems_security",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledOnce());
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "review_coordination_required",
      }),
    );
    await vi.waitFor(() => expect(tracker.fetchCandidates).toHaveBeenCalledTimes(2));
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
        mode: "Ready",
        reason: "merge_queue_required",
      }),
    );
    await scheduler.close();
    expect(agent.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ role: "specialist_review" }),
    );
    expect(
      opened.sqlite
        .prepare("select reviewer_role from review_records order by reviewer_role")
        .all(),
    ).toEqual([{ reviewer_role: "integrative_review" }, { reviewer_role: "specialist_review" }]);
    expect(
      opened.sqlite
        .prepare("select decision, required_specialist_names_json from review_sets")
        .get(),
    ).toEqual({
      decision: "approve",
      required_specialist_names_json: '["systems_security"]',
    });
    await opened.close();
  });

  it("completes a repaired parent issue through Review and Done tracker lanes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-repair-parent-completion-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
    await observeIssue(opened.database, {
      issue: { ...candidate, state: "In Progress" },
      observedAt: "2026-07-13T10:00:00Z",
      providerRevision: "provider-revision-1",
      transitionId: "stage-parent-running",
    });
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values ('issue', 'issue-1', 'run-1', 'Ready', '2026-07-13T10:01:00Z',
          '2026-07-13T10:01:00Z', null, 'In Progress', 'repair_completed')`,
      )
      .run();
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(async (_id: string, lane: string) => ({
        providerRequestId: `request-${lane}`,
        responsePayloadHash: `sha256:${lane}`,
        result: "updated",
        resultRevision: lane === "Review" ? "provider-revision-2" : "provider-revision-3",
      })),
    };
    const scheduler = createProductionScheduler({
      database: opened.database,
      environment: {},
      prompt: "Implement {{ issue.title }}.",
      serviceRunId: "run-1",
      snapshot: { effectiveConfig, id: "config-1" } as never,
      tracker,
    });

    await scheduler.start();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select state from issues").get()).toEqual({ state: "Review" }),
    );
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(opened.sqlite.prepare("select state from issues").get()).toEqual({ state: "Done" }),
    );
    await scheduler.close();

    expect(tracker.updateIssueLane.mock.calls.map((call) => call[1])).toEqual(["Review", "Done"]);
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite
        .prepare("select from_stage, to_stage from stage_transitions order by entered_at")
        .all(),
    ).toEqual([
      { from_stage: null, to_stage: "In Progress" },
      { from_stage: "In Progress", to_stage: "Review" },
      { from_stage: "Review", to_stage: "Done" },
    ]);
    await opened.close();
  });

  it("drives an interval synthesis proposal through supervised review and merge without tracker mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-production-synthesis-"));
    directories.push(directory);
    const workspaceRoot = path.join(directory, "workspaces");
    await mkdir(workspaceRoot);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
        `insert into operators (
          id, auth_subject, capabilities_json, tracker_login, status,
          version, created_at, updated_at
        ) values (
          'operator-1', 'subject-1', '["merge_queue.write"]', 'maintainer',
          'active', 1, 't0', 't0'
        )`,
      )
      .run();
    const completed = { ...candidate, id: "completed-issue", state: "Done" as const };
    await observeIssue(opened.database, {
      issue: completed,
      observedAt: "2026-07-13T09:00:00Z",
      providerRevision: "revision-done",
      transitionId: "completed-baseline",
    });
    opened.sqlite
      .prepare(
        `insert into lessons (
          id, created_at, work_ref_kind, work_ref_id, source, text, evidence_json
        ) values (
          'lesson-1', '2026-07-13T09:01:00Z', 'issue', 'completed-issue',
          'confusion', 'Require current-head verification',
          '[{"kind":"commit","sha":"abc1234"}]'
        )`,
      )
      .run();
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(),
    };
    const agent: AgentAdapter = {
      launch: vi.fn(async (request: AgentLaunchRequest) => {
        const role = request.preflight.role;
        return {
          cancel: vi.fn(async () => undefined),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                attempt_id: request.attemptId,
                event: "session_started" as const,
                model: "gpt-test",
                reasoning_effort: role === "synthesis" ? "high" : "medium",
                session_id: `${role}-session`,
                thread_id: `${role}-thread`,
                timestamp: "2026-07-13T10:00:01Z",
                turn_id: `${role}-turn`,
              };
              yield {
                attempt_id: request.attemptId,
                event: "terminal_result_reported" as const,
                result:
                  role === "synthesis"
                    ? {
                        branch: "symphony/system-synthesis-local",
                        cited_lesson_ids: ["lesson-1"],
                        decision: "propose_changes",
                        evidence: [{ kind: "commit", sha: "def5678" }],
                        handoff: {
                          acceptance_criteria: [
                            "Every proposed rule change cites durable lesson ids",
                          ],
                          commands: [{ command: "make verify-fast", exit_code: 0 }],
                          decisions_fixed: [],
                          files_changed: ["WORKFLOW.md"],
                          goal: "Synthesize durable lessons",
                          open_items: [],
                          revision: "def5678",
                        },
                        pull_request: { base_ref: "main", title: "Improve workflow rules" },
                        repository_revision: "def5678",
                        rule_changes: [
                          {
                            action: "add",
                            lesson_ids: ["lesson-1"],
                            rationale: "Prevent recurrence",
                            rule_id: "rule-new",
                            text: "Require current-head verification",
                          },
                        ],
                      }
                    : {
                        decision: "approve",
                        evidence: [{ kind: "commit", sha: "def5678" }],
                        findings: [],
                        target_sha: "def5678",
                      },
                session_id: `${role}-session`,
                timestamp: "2026-07-13T10:00:02Z",
              };
              yield {
                attempt_id: request.attemptId,
                event: "turn_completed" as const,
                provider_reason: "completed",
                session_id: `${role}-session`,
                timestamp: "2026-07-13T10:00:03Z",
              };
            },
          },
          processGroupId: role === "synthesis" ? 7400 : 7402,
          processId: role === "synthesis" ? 7401 : 7403,
          waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
        };
      }),
      manifest: vi.fn(async () => manifest),
      preflight: vi.fn(async (request: AgentPreflightRequest) => ({
        adapterVersion: manifest.adapter_version,
        manifest,
        protocolSchemaHash: manifest.protocol.schema_hash,
        resolvedSkills: request.requiredSkills,
        role: request.role,
        submitPlanSchema: null,
        terminalResultSchema: request.terminalResultSchema,
      })),
    };
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      populateIssueWorkspace: vi.fn(async () => {
        throw new Error("issue workspace not expected");
      }),
      populateSystemJobWorkspace: vi.fn(async (request) => {
        const workspacePath = systemJobWorkspacePath(
          request.workspaceRoot,
          request.kind,
          request.id,
        );
        await mkdir(workspacePath, { recursive: true });
        return {
          baseRef: "main",
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter" as const,
          createdAt: "2026-07-13T10:00:00Z",
          localBranch: "symphony/system-synthesis-local",
          repository: request.repository,
          workspacePath,
        };
      }),
    };
    const snapshot = {
      base_ref: "main",
      checks: [],
      head_sha: "def5678",
      is_draft: false,
      mergeable: true,
      observed_base_sha: "abc1234",
      post_merge_checks: [],
      pr_number: 43,
      pr_state: "open" as const,
      pr_url: "https://github.com/owner/repo/pull/43",
      required_check_source: "union" as const,
      review_decision: "approved" as const,
      reviews: [
        {
          author: "maintainer",
          commit_sha: "def5678",
          state: "approved",
          submitted_at: "2026-07-13T10:05:00Z",
        },
      ],
      unresolved_threads: [],
    };
    const repositoryHostingAdapter: RepositoryHostingAdapter = {
      createRepairPullRequest: vi.fn(),
      ensurePullRequest: vi.fn(async (_workRef, headSha) => ({
        mutation: {
          providerRequestId: "request-synthesis-pr",
          responsePayloadHash: "sha256:synthesis-pr",
          result: "created",
          resultRevision: headSha,
        },
        number: 43,
        url: snapshot.pr_url,
      })),
      fetchPostMergeStatus: vi.fn(async () => ({
        ...snapshot,
        head_sha: "fedcba9",
        pr_state: "merged" as const,
      })),
      fetchPullRequestSnapshot: vi.fn(async () => snapshot),
      mergePullRequest: vi.fn(async () => ({
        mergeSha: "fedcba9",
        mutation: {
          providerRequestId: "request-synthesis-merge",
          responsePayloadHash: "sha256:synthesis-merge",
          result: "merged",
          resultRevision: "fedcba9",
        },
      })),
      publishBranch: vi.fn(async () => ({
        branch: "symphony/system-synthesis-deadbeefdeadbeef",
        headSha: "def5678",
        mutation: {
          providerRequestId: "request-synthesis-publish",
          responsePayloadHash: "sha256:synthesis-publish",
          result: "published",
          resultRevision: "def5678",
        },
      })),
      updateBranch: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const scheduler = createProductionScheduler({
      agent,
      database: opened.database,
      environment: {},
      logger,
      prompt: "<!-- rules:start --><!-- rules:end -->",
      repositoryAdapter,
      repositoryHostingAdapter,
      review: {
        collectEvidence: vi.fn(async (request) => ({
          baseSha: request.baseSha,
          changeClass: request.changeClass,
          changedFiles: ["WORKFLOW.md"],
          changedLines: 4,
          diff: "diff --git a/WORKFLOW.md b/WORKFLOW.md",
          patchIdentity: "sha256:synthesis-patch",
          repositoryDocs: [],
          targetSha: request.targetSha,
          verificationRecordId: request.verificationRecordId,
        })),
      },
      serviceRunId: "run-1",
      snapshot: {
        effectiveConfig: {
          ...effectiveConfig,
          "learning.interval_issues": 1,
          "workspace.root": workspaceRoot,
        },
        id: "config-1",
      } as never,
      tracker,
      verification: {
        execute: vi.fn(async () => ({
          commandHash: "sha256:command",
          endedAt: "2026-07-13T10:01:00Z",
          environmentPolicyHash: "sha256:environment",
          exitCode: 0,
          result: "passed" as const,
          startedAt: "2026-07-13T10:00:30Z",
          stderr: "",
          stdout: "all passed",
        })),
        readRevision: vi.fn(async () => "def5678"),
      },
    });

    await scheduler.start();
    await vi.waitFor(() =>
      expect(
        opened.sqlite.prepare("select reason from claims where work_ref_kind = 'system_job'").get(),
      ).toEqual({ reason: "synthesis_verification_required" }),
    );
    for (const expectedReason of [
      "pull_request_required",
      "pull_request_hygiene_required",
      "review_required",
      "review_coordination_required",
      "merge_queue_required",
    ]) {
      await scheduler.trigger();
      await vi.waitFor(() =>
        expect({
          claim: opened.sqlite
            .prepare("select reason from claims where work_ref_kind = 'system_job'")
            .get(),
          warnings: logger.warn.mock.calls,
        }).toEqual({ claim: { reason: expectedReason }, warnings: [] }),
      );
    }
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(
        opened.sqlite
          .prepare("select mode, reason from claims where work_ref_kind = 'system_job'")
          .get(),
      ).toEqual({
        mode: "RetryQueued",
        reason: "post_merge_verification_required",
      }),
    );
    opened.sqlite
      .prepare(
        "update claims set retry_due_at = '2000-01-01T00:00:00.000Z' where work_ref_kind = 'system_job'",
      )
      .run();
    await scheduler.trigger();
    await vi.waitFor(() =>
      expect(
        opened.sqlite.prepare("select status from system_jobs where kind = 'synthesis'").get(),
      ).toEqual({
        status: "done",
      }),
    );
    await scheduler.close();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(tracker.updateIssueLane).not.toHaveBeenCalled();
    expect(agent.launch).toHaveBeenCalledTimes(2);
    expect(repositoryHostingAdapter.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ system_job_id: expect.any(String) }),
      "def5678",
      "squash",
      expect.any(Object),
      "synthesis",
    );
    expect(
      opened.sqlite
        .prepare("select count(*) as count from claims where work_ref_kind = 'system_job'")
        .get(),
    ).toEqual({
      count: 0,
    });
    await opened.close();
  });

  it.each([
    "no_change",
    "needs_input",
  ] as const)("closes a synthesis %s result without repository or tracker mutation", async (decision) => {
    const directory = await mkdtemp(path.join(tmpdir(), `symphony-synthesis-${decision}-`));
    directories.push(directory);
    const workspaceRoot = path.join(directory, "workspaces");
    await mkdir(workspaceRoot);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
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
    await observeIssue(opened.database, {
      issue: { ...candidate, id: `completed-${decision}`, state: "Done" },
      observedAt: "2026-07-13T09:00:00Z",
      providerRevision: `revision-${decision}`,
      transitionId: `baseline-${decision}`,
    });
    const result = {
      cited_lesson_ids: [],
      decision,
      evidence: [{ kind: "commit" as const, sha: "abc1234" }],
      handoff: {
        acceptance_criteria: [],
        commands: [],
        decisions_fixed: [],
        files_changed: [],
        goal: "Synthesize lessons",
        open_items: [],
        revision: "abc1234",
      },
      ...(decision === "needs_input"
        ? {
            question: {
              default: "Keep",
              options: ["Keep", "Remove"],
              text: "Resolve the conflicting rule",
            },
          }
        : {}),
      rule_changes: [],
    };
    const agent: AgentAdapter = {
      launch: vi.fn(async (request: AgentLaunchRequest) => ({
        cancel: vi.fn(async () => undefined),
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              attempt_id: request.attemptId,
              event: "session_started" as const,
              model: "gpt-test",
              reasoning_effort: "high",
              session_id: `${decision}-session`,
              thread_id: `${decision}-thread`,
              timestamp: "2026-07-13T10:00:01Z",
              turn_id: `${decision}-turn`,
            };
            yield {
              attempt_id: request.attemptId,
              event: "terminal_result_reported" as const,
              result,
              session_id: `${decision}-session`,
              timestamp: "2026-07-13T10:00:02Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "turn_completed" as const,
              provider_reason: "completed",
              session_id: `${decision}-session`,
              timestamp: "2026-07-13T10:00:03Z",
            };
          },
        },
        processGroupId: 7500,
        processId: 7501,
        waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
      })),
      manifest: vi.fn(async () => manifest),
      preflight: vi.fn(async (request: AgentPreflightRequest) => ({
        adapterVersion: manifest.adapter_version,
        manifest,
        protocolSchemaHash: manifest.protocol.schema_hash,
        resolvedSkills: request.requiredSkills,
        role: request.role,
        submitPlanSchema: null,
        terminalResultSchema: request.terminalResultSchema,
      })),
    };
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      populateIssueWorkspace: vi.fn(async () => {
        throw new Error("issue workspace not expected");
      }),
      populateSystemJobWorkspace: vi.fn(async (request) => {
        const workspacePath = systemJobWorkspacePath(
          request.workspaceRoot,
          request.kind,
          request.id,
        );
        await mkdir(workspacePath, { recursive: true });
        return {
          baseRef: "main",
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter" as const,
          createdAt: "2026-07-13T10:00:00Z",
          localBranch: "symphony/system-synthesis-local",
          repository: request.repository,
          workspacePath,
        };
      }),
    };
    const repositoryHostingAdapter: RepositoryHostingAdapter = {
      createRepairPullRequest: vi.fn(),
      ensurePullRequest: vi.fn(),
      fetchPostMergeStatus: vi.fn(),
      fetchPullRequestSnapshot: vi.fn(),
      mergePullRequest: vi.fn(),
      publishBranch: vi.fn(),
      updateBranch: vi.fn(),
    };
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(),
      updateIssueLane: vi.fn(),
    };
    const scheduler = createProductionScheduler({
      agent,
      database: opened.database,
      environment: {},
      prompt: "<!-- rules:start --><!-- rules:end -->",
      repositoryAdapter,
      repositoryHostingAdapter,
      serviceRunId: "run-1",
      snapshot: {
        effectiveConfig: {
          ...effectiveConfig,
          "learning.interval_issues": 1,
          "workspace.root": workspaceRoot,
        },
        id: "config-1",
      } as never,
      tracker,
      verification: { readRevision: vi.fn(async () => "abc1234") },
    });

    await scheduler.start();
    await vi.waitFor(() =>
      expect(
        opened.sqlite.prepare("select status from system_jobs where kind = 'synthesis'").get(),
      ).toEqual({
        status: decision === "no_change" ? "done" : "human",
      }),
    );
    await scheduler.close();

    expect(repositoryHostingAdapter.publishBranch).not.toHaveBeenCalled();
    expect(repositoryHostingAdapter.ensurePullRequest).not.toHaveBeenCalled();
    expect(tracker.updateIssueLane).not.toHaveBeenCalled();
    expect(
      opened.sqlite
        .prepare("select mode, reason from claims where work_ref_kind = 'system_job'")
        .get(),
    ).toEqual(
      decision === "no_change" ? undefined : { mode: "AwaitingHuman", reason: "needs_input" },
    );
    await opened.close();
  });
});

function createSpecialistAgent(): AgentAdapter {
  return {
    launch: vi.fn(async (request: AgentLaunchRequest) => ({
      cancel: vi.fn(async () => undefined),
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            attempt_id: request.attemptId,
            event: "session_started" as const,
            model: "gpt-test",
            reasoning_effort: "high",
            session_id: "specialist-session",
            thread_id: "specialist-thread",
            timestamp: "2026-07-13T10:08:00Z",
            turn_id: "specialist-turn",
          };
          yield {
            attempt_id: request.attemptId,
            event: "terminal_result_reported" as const,
            result: {
              decision: "approve",
              evidence: [{ kind: "commit", sha: "def5678" }],
              findings: [],
              target_sha: "def5678",
            },
            session_id: "specialist-session",
            timestamp: "2026-07-13T10:08:01Z",
          };
          yield {
            attempt_id: request.attemptId,
            event: "turn_completed" as const,
            provider_reason: "completed",
            session_id: "specialist-session",
            timestamp: "2026-07-13T10:08:02Z",
          };
        },
      },
      processGroupId: 7320,
      processId: 7321,
      waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
    })),
    manifest: vi.fn(async () => manifest),
    preflight: vi.fn(async (request: AgentPreflightRequest) => ({
      adapterVersion: manifest.adapter_version,
      manifest,
      protocolSchemaHash: manifest.protocol.schema_hash,
      resolvedSkills: request.requiredSkills,
      role: request.role,
      submitPlanSchema: null,
      terminalResultSchema: request.terminalResultSchema,
    })),
  };
}
