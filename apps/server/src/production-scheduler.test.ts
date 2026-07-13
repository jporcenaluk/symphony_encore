import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentAdapter,
  type AgentLaunchRequest,
  type AgentPreflightRequest,
  type AgentSession,
  issueWorkspacePath,
  type WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import type { AgentAdapterManifest, Issue } from "@symphony/contracts";
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
  "agent.command": "codex app-server",
  "agent.max_concurrent": 1,
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

  it("dispatches an eligible candidate through durable lifecycle closure", async () => {
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
    const outcome = {
      actions_requested: [],
      confusions: [],
      evidence: [],
      handoff: {
        acceptance_criteria: candidate.acceptance_criteria,
        commands: [],
        decisions_fixed: [],
        files_changed: [],
        goal: candidate.title,
        open_items: candidate.acceptance_criteria,
        revision: "abc1234",
      },
      status: "needs_rework",
      summary: "More work is needed.",
    };
    const agent: AgentAdapter = {
      launch: vi.fn(async (request: AgentLaunchRequest) => {
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
        const planDecision = request.onPlanSubmitted?.(submittedPlan);
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
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter",
          createdAt: "2026-07-13T10:00:01.000Z",
          localBranch: "symphony/org-9",
          repository: input.repository,
          workspacePath,
        };
      },
    };
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async () => ({
        cursor: null,
        hasMore: false,
        items: [candidate],
      })),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(async () => ({
        cursor: null,
        hasMore: false,
        items: [{ id: candidate.id, revision: "revision-7", state: "Todo" }],
      })),
      updateIssueLane: vi.fn(async () => ({
        providerRequestId: "request-1",
        responsePayloadHash: "sha256:receipt",
        result: "updated",
        resultRevision: "revision-8",
      })),
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
    await scheduler.close();

    expect(agent.launch).toHaveBeenCalledOnce();
    expect(tracker.updateIssueLane).toHaveBeenCalledWith(
      candidate.id,
      "In Progress",
      "dispatch.eligible",
      expect.any(Object),
    );
    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "closed",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "implementation_rework",
    });
    expect(opened.sqlite.prepare("select status from budget_reservations").get()).toEqual({
      status: "settled",
    });
    expect(opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "validated",
    });
    await expect(readFile(path.join(workspaceRoot, "ORG-9", "PLAN.md"), "utf8")).resolves.toContain(
      "Status: validated",
    );
    await opened.close();
  });
});
