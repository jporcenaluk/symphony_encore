import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentAdapter,
  AgentLaunchRequest,
  AgentPreflightRequest,
  AgentSession,
  WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import { issueWorkspacePath } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  type Issue,
  type Plan,
  PlanReviewResultSchema,
} from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  type OpenedDatabase,
  observeIssue,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPlannedPlanReviewAttemptLifecycle } from "./plan-review-attempt-lifecycle.js";
import { planHighRiskPlanReviewAttempt } from "./plan-review-attempt-planner.js";

let directory: string;
let workspaceRoot: string;
let opened: OpenedDatabase;

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

const issue: Issue = {
  acceptance_criteria: ["Review every high-risk Plan independently"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Dispatch a fresh Plan reviewer.",
  id: "issue-1",
  identifier: "ORG-12",
  labels: ["security"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Review the validated Plan",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/12",
};

const plan: Plan = {
  acceptance_criteria: [
    {
      criterion_id: "criterion-1",
      criterion_text: issue.acceptance_criteria[0] as string,
      planned_evidence: "Plan-review lifecycle coverage",
    },
  ],
  approach: "Review the security-sensitive change.",
  approved_by_attempt_id: null,
  created_at: "2026-07-13T10:01:00Z",
  created_by_attempt_id: "builder-attempt",
  estimated_changed_lines: 50,
  estimated_files: 1,
  id: "plan-1",
  proposed_paths: ["apps/server/src/auth.ts"],
  revision: 1,
  risk_facts: ["risk.security_auth"],
  status: "validated",
  validated_at: "2026-07-13T10:02:00Z",
  verification_commands: ["make verify-fast"],
  work_ref: { issue_id: issue.id },
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-plan-review-lifecycle-"));
  workspaceRoot = path.join(directory, "workspaces");
  await mkdir(workspaceRoot);
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
  await observeIssue(opened.database, {
    issue,
    observedAt: issue.updated_at,
    providerRevision: "tracker-revision-1",
    transitionId: "baseline-1",
  });
  seedBuilderAndPlan();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("Plan-review attempt lifecycle", () => {
  it("charges, launches in the existing issue workspace, consumes, and approves atomically", async () => {
    const order: string[] = [];
    const agent = createAgent(order, 1);
    const repositoryAdapter = createRepositoryAdapter(order);
    let sequence = 0;
    const planned = await planHighRiskPlanReviewAttempt({
      adapter: agent,
      configSnapshotId: "config-1",
      configuration: planningConfiguration(),
      database: opened.database,
      issue,
      newId: () => `review-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan,
      serviceRunId: "run-1",
      terminalResultSchema: PlanReviewResultSchema,
    });

    const consumption = await runPlannedPlanReviewAttemptLifecycle({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      attemptTokenCap: 400_000,
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      issue,
      maxPlanRevisions: 2,
      newId: () => `review-${++sequence}`,
      now: () => "2026-07-13T10:04:00Z",
      plan,
      planned,
      repositoryAdapter,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      serviceRunId: "run-1",
      sourceEnvironment: { GH_TOKEN: "must-not-reach-worker" },
      usdCap: 5,
      workspaceRoot,
    });

    expect(consumption).toMatchObject({ kind: "terminal_result" });
    expect(order).toEqual(["populate", "launch"]);
    expect(agent.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.not.objectContaining({ GH_TOKEN: expect.anything() }),
        profile: "economy",
        prompt: expect.stringContaining("independent Plan reviewer"),
        title: "plan-review:issue-1: Review the validated Plan",
      }),
    );
    expect(
      opened.sqlite
        .prepare("select status, approved_by_attempt_id from plans where id = 'plan-1'")
        .get(),
    ).toEqual({ approved_by_attempt_id: planned.attemptId, status: "approved" });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "implementation_after_plan_approval",
    });
    expect(
      opened.sqlite.prepare("select role, status from attempts order by attempt_number").all(),
    ).toEqual([
      { role: "implementation", status: "closed" },
      { role: "plan_review", status: "closed" },
    ]);
  });

  it("closes a mismatched semantic revision as a role failure without changing the Plan", async () => {
    const agent = createAgent([], 2);
    let sequence = 0;
    const planned = await planHighRiskPlanReviewAttempt({
      adapter: agent,
      configSnapshotId: "config-1",
      configuration: planningConfiguration(),
      database: opened.database,
      issue,
      newId: () => `invalid-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan,
      serviceRunId: "run-1",
      terminalResultSchema: PlanReviewResultSchema,
    });

    const consumption = await runPlannedPlanReviewAttemptLifecycle({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      attemptTokenCap: 400_000,
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      issue,
      maxPlanRevisions: 2,
      newId: () => `invalid-${++sequence}`,
      now: () => "2026-07-13T10:04:00Z",
      plan,
      planned,
      repositoryAdapter: createRepositoryAdapter([]),
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      serviceRunId: "run-1",
      sourceEnvironment: {},
      usdCap: 5,
      workspaceRoot,
    });

    expect(consumption).toMatchObject({ errorCode: "result_invalid", kind: "failure" });
    expect(opened.sqlite.prepare("select status from plans where id = 'plan-1'").get()).toEqual({
      status: "validated",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "result_invalid",
    });
    const terminal = opened.sqlite
      .prepare("select result_kind, payload_json from terminal_results where attempt_id = ?")
      .get(planned.attemptId) as { payload_json: string; result_kind: string };
    expect(terminal.result_kind).toBe("execution_failure");
    expect(JSON.parse(terminal.payload_json)).toMatchObject({
      role: "plan_review",
      status: "failed",
    });
  });

  it("settles a charged continuation when launch fails before session binding", async () => {
    const agent = createAgent([], 1);
    agent.launch = vi.fn(async () => {
      throw new Error("agent.launch_failed");
    });
    let sequence = 0;
    const planned = await planHighRiskPlanReviewAttempt({
      adapter: agent,
      configSnapshotId: "config-1",
      configuration: planningConfiguration(),
      database: opened.database,
      issue,
      newId: () => `failed-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan,
      serviceRunId: "run-1",
      terminalResultSchema: PlanReviewResultSchema,
    });

    await expect(
      runPlannedPlanReviewAttemptLifecycle({
        adapter: agent,
        agentCommand: "codex app-server",
        afterCreateCommand: null,
        allowlistedEnvironmentNames: [],
        attemptTokenCap: 400_000,
        beforeRunCommand: null,
        database: opened.database,
        hookTimeoutMs: 60_000,
        issue,
        maxPlanRevisions: 2,
        newId: () => `failed-${++sequence}`,
        now: () => "2026-07-13T10:04:00Z",
        plan,
        planned,
        repositoryAdapter: createRepositoryAdapter([]),
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        serviceRunId: "run-1",
        sourceEnvironment: {},
        usdCap: 5,
        workspaceRoot,
      }),
    ).rejects.toThrow("agent.launch_failed");

    expect(
      opened.sqlite
        .prepare("select status, failure_class from attempts where id = ?")
        .get(planned.attemptId),
    ).toEqual({ failure_class: "infrastructure", status: "closed" });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "plan_review_launch_failed",
    });
    expect(opened.sqlite.prepare("select status from plans where id = 'plan-1'").get()).toEqual({
      status: "validated",
    });
    expect(opened.sqlite.prepare("select status from budget_reservations").get()).toEqual({
      status: "settled",
    });
    expect(
      opened.sqlite.prepare("select sum(reserved) as reserved from budget_ledgers").get(),
    ).toEqual({
      reserved: 0,
    });
  });
});

function planningConfiguration() {
  return {
    budgetLimits: {
      attemptTokens: 400_000,
      attemptUsd: 5,
      fleetTokens: 10_000_000,
      fleetUsd: 50,
      issueTokens: 2_000_000,
      issueUsd: 10,
    },
    enabledProfiles: ["economy", "standard", "deep"] as const,
    estimateTokensByProfile: { deep: 300_000, economy: 100_000, standard: 200_000 },
    historyMinSamples: 10,
    historyWindowSamples: 50,
    leaseTtlMs: 120_000,
    requiredSkills: [],
    riskFloorRules: [],
    routeProfiles: {
      adjudication: "deep" as const,
      implementation: {
        high_risk: "deep" as const,
        standard: "standard" as const,
        trivial: "economy" as const,
      },
      integrative_review: "standard" as const,
      plan_review: "economy" as const,
      specialist_review: "deep" as const,
      synthesis: "deep" as const,
    },
    skillRoots: [],
    workspaceRoot,
  };
}

function createAgent(order: string[], planRevision: number): AgentAdapter {
  return {
    launch: vi.fn(async (request: AgentLaunchRequest) => {
      order.push("launch");
      const session: AgentSession = {
        cancel: vi.fn(async () => undefined),
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              attempt_id: request.attemptId,
              event: "session_started" as const,
              model: "gpt-test",
              reasoning_effort: "low",
              session_id: "review-session",
              thread_id: "review-thread",
              timestamp: "2026-07-13T10:03:01Z",
              turn_id: "review-turn",
            };
            yield {
              attempt_id: request.attemptId,
              event: "terminal_result_reported" as const,
              result: {
                decision: "approve",
                evidence: [{ kind: "file", path: "PLAN.md" }],
                findings: [],
                handoff: {
                  acceptance_criteria: issue.acceptance_criteria,
                  commands: [],
                  decisions_fixed: [],
                  files_changed: [],
                  goal: issue.title,
                  open_items: [],
                  revision: "abc1234",
                },
                plan_revision: planRevision,
              },
              session_id: "review-session",
              timestamp: "2026-07-13T10:03:02Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "turn_completed" as const,
              provider_reason: "completed",
              session_id: "review-session",
              timestamp: "2026-07-13T10:03:03Z",
            };
          },
        },
        processGroupId: 5320,
        processId: 5321,
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
      submitPlanSchema: null,
      terminalResultSchema: request.terminalResultSchema,
    })),
  };
}

function createRepositoryAdapter(order: string[]): WorkspaceRepositoryAdapter {
  return {
    async populateIssueWorkspace(input) {
      order.push("populate");
      const workspacePath = issueWorkspacePath(input.workspaceRoot, input.identifier);
      await mkdir(workspacePath);
      return {
        baseSha: "abc1234",
        checkoutMethod: "trusted_repository_adapter",
        createdAt: "2026-07-13T10:03:00Z",
        localBranch: "symphony/org-12",
        repository: input.repository,
        workspacePath,
      };
    },
  };
}

function seedBuilderAndPlan(): void {
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id
      ) values (
        'builder-attempt', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG-12',
        'config-1', 'deep', 'gpt-test', 'high', '[]', 'high_risk',
        't0', 't1', 'closed', 'builder-result'
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into plans (
        id, work_ref_kind, work_ref_id, revision, status, approach,
        acceptance_criteria_json, proposed_paths_json, verification_commands_json,
        estimated_files, estimated_changed_lines, risk_facts_json,
        created_by_attempt_id, created_at, validated_at, approved_by_attempt_id
      ) values (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      plan.id,
      issue.id,
      plan.revision,
      plan.status,
      plan.approach,
      JSON.stringify(plan.acceptance_criteria),
      JSON.stringify(plan.proposed_paths),
      JSON.stringify(plan.verification_commands),
      plan.estimated_files,
      plan.estimated_changed_lines,
      JSON.stringify(plan.risk_facts),
      plan.created_by_attempt_id,
      plan.created_at,
      plan.validated_at,
      plan.approved_by_attempt_id,
    );
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null, 'In Progress', 'plan_review_required')`,
    )
    .run();
}
