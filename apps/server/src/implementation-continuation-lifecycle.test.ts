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
  ImplementationOutcomeSchema,
  type Issue,
  type Plan,
  type PlanReviewResult,
  PlanSchema,
} from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  type OpenedDatabase,
  observeIssue,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPlannedImplementationContinuationLifecycle } from "./implementation-continuation-lifecycle.js";
import { planImplementationContinuation } from "./implementation-continuation-planner.js";
import { createInitialPlanSubmissionHandler } from "./initial-plan-submission.js";

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
  acceptance_criteria: ["Continue an approved high-risk Plan"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Continue from durable state.",
  id: "issue-1",
  identifier: "ORG-14",
  labels: ["security"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Execute the approved Plan",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/14",
};

const plan: Plan = {
  acceptance_criteria: [
    {
      criterion_id: "criterion-1",
      criterion_text: issue.acceptance_criteria[0] as string,
      planned_evidence: "Lifecycle coverage",
    },
  ],
  approach: "Implement the reviewed change.",
  approved_by_attempt_id: "review-attempt",
  created_at: "2026-07-13T10:01:00Z",
  created_by_attempt_id: "builder-attempt",
  estimated_changed_lines: 20,
  estimated_files: 1,
  id: "plan-1",
  proposed_paths: ["apps/server/src/feature.ts"],
  revision: 1,
  risk_facts: ["risk.security_auth"],
  status: "approved",
  validated_at: "2026-07-13T10:02:00Z",
  verification_commands: ["make verify-fast"],
  work_ref: { issue_id: issue.id },
};

const reviewResult: PlanReviewResult = {
  decision: "approve",
  evidence: [{ kind: "file", path: "PLAN.md" }],
  findings: [],
  handoff: {
    acceptance_criteria: issue.acceptance_criteria,
    commands: [{ command: "make verify-fast", exit_code: 0 }],
    decisions_fixed: [],
    files_changed: [],
    goal: issue.title,
    open_items: issue.acceptance_criteria,
    revision: "abc1234",
  },
  plan_revision: 1,
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-implementation-continuation-"));
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
  seedApprovedPlan();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("implementation continuation lifecycle", () => {
  it("charges, reuses the workspace, permits approved-Plan action, and closes", async () => {
    const order: string[] = [];
    const outcome = {
      actions_requested: [],
      confusions: [],
      evidence: [],
      handoff: reviewResult.handoff,
      status: "needs_rework",
      summary: "One implementation detail remains.",
    };
    const agent = createAgent(order, outcome);
    let sequence = 0;
    const planned = await planImplementationContinuation({
      adapter: agent,
      configSnapshotId: "config-1",
      configuration: planningConfiguration(),
      database: opened.database,
      issue,
      mode: "approved_plan",
      newId: () => `continuation-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan,
      reviewResult,
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });
    const safety = new PersistenceSafetyController(vi.fn(async () => undefined));

    const consumption = await runPlannedImplementationContinuationLifecycle({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      attemptTokenCap: 400_000,
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      issue,
      newId: () => `continuation-${++sequence}`,
      now: () => "2026-07-13T10:04:00Z",
      onPlanSubmitted: createInitialPlanSubmissionHandler({
        attemptId: planned.attemptId,
        database: opened.database,
        issue,
        now: () => "2026-07-13T10:03:30Z",
        provisionalClassification: {
          changeClass: "high_risk",
          floor: "high_risk",
          reasons: ["reviewed high-risk Plan"],
        },
        riskPathPatterns: [],
        safety,
        trivialMaxChangedLines: 25,
        trivialPathPatterns: [],
        workspacePath: planned.dispatch.attempt.workspacePath,
      }),
      planned,
      repositoryAdapter: createRepositoryAdapter(order),
      safety,
      serviceRunId: "run-1",
      sourceEnvironment: { GH_TOKEN: "must-not-reach-worker" },
      usdCap: 5,
      workspaceRoot,
    });

    expect(consumption).toEqual({ kind: "terminal_result", result: outcome });
    expect(order).toEqual(["populate", "launch"]);
    expect(agent.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.not.objectContaining({ GH_TOKEN: expect.anything() }),
        onPlanSubmitted: expect.any(Function),
        profile: "deep",
        title: "implementation:issue-1: Execute the approved Plan",
      }),
    );
    expect(opened.sqlite.prepare("select status from plans where id = 'plan-1'").get()).toEqual({
      status: "approved",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "implementation_rework",
    });
    expect(
      opened.sqlite.prepare("select role, status from attempts order by attempt_number").all(),
    ).toEqual([
      { role: "implementation", status: "closed" },
      { role: "plan_review", status: "closed" },
      { role: "implementation", status: "closed" },
    ]);
  });

  it("requires a rejected-Plan continuation to validate a revision before returning to review", async () => {
    opened.sqlite
      .prepare("update plans set status = 'rejected', approved_by_attempt_id = null")
      .run();
    opened.sqlite.prepare("update claims set reason = 'plan_revision_required'").run();
    const reworkResult: PlanReviewResult = {
      ...reviewResult,
      decision: "needs_rework",
      findings: [
        {
          behavior: "Rollback proof is missing",
          blocking: true,
          evidence: [{ kind: "file", path: "PLAN.md" }],
          id: "finding-1",
          severity: "high",
        },
      ],
    };
    const agent = createRevisionAgent();
    let sequence = 0;
    const planned = await planImplementationContinuation({
      adapter: agent,
      configSnapshotId: "config-1",
      configuration: planningConfiguration(),
      database: opened.database,
      issue,
      mode: "plan_revision",
      newId: () => `revision-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan: { ...plan, approved_by_attempt_id: null, status: "rejected" },
      reviewResult: reworkResult,
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });
    const safety = new PersistenceSafetyController(vi.fn(async () => undefined));

    const consumption = await runPlannedImplementationContinuationLifecycle({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      attemptTokenCap: 400_000,
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      issue,
      newId: () => `revision-${++sequence}`,
      now: () => "2026-07-13T10:04:00Z",
      onPlanSubmitted: createInitialPlanSubmissionHandler({
        attemptId: planned.attemptId,
        database: opened.database,
        issue,
        now: () => "2026-07-13T10:03:30Z",
        provisionalClassification: {
          changeClass: "high_risk",
          floor: "high_risk",
          reasons: ["reviewed high-risk Plan"],
        },
        riskPathPatterns: [],
        safety,
        trivialMaxChangedLines: 25,
        trivialPathPatterns: [],
        workspacePath: planned.dispatch.attempt.workspacePath,
      }),
      planned,
      repositoryAdapter: createRepositoryAdapter([]),
      safety,
      serviceRunId: "run-1",
      sourceEnvironment: {},
      usdCap: 5,
      workspaceRoot,
    });

    expect(consumption).toMatchObject({
      kind: "terminal_result",
      result: { status: "plan_ready" },
    });
    expect(
      opened.sqlite.prepare("select revision, status from plans order by revision").all(),
    ).toEqual([
      { revision: 1, status: "rejected" },
      { revision: 2, status: "validated" },
    ]);
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "plan_review_required",
    });
  });
});

function planningConfiguration() {
  return {
    attemptTokenCap: 400_000,
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
    maxTurns: 8,
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

function createAgent(order: string[], outcome: unknown): AgentAdapter {
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
              reasoning_effort: "high",
              session_id: "continuation-session",
              thread_id: "continuation-thread",
              timestamp: "2026-07-13T10:03:01Z",
              turn_id: "continuation-turn",
            };
            yield {
              action_id: "action-1",
              attempt_id: request.attemptId,
              cwd: request.workspacePath,
              event: "action_started" as const,
              exit_code: null,
              kind: "file_change",
              output_ref: null,
              result_status: null,
              session_id: "continuation-session",
              summary: "Implement approved Plan",
              timestamp: "2026-07-13T10:03:02Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "terminal_result_reported" as const,
              result: outcome,
              session_id: "continuation-session",
              timestamp: "2026-07-13T10:03:03Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "turn_completed" as const,
              provider_reason: "completed",
              session_id: "continuation-session",
              timestamp: "2026-07-13T10:03:04Z",
            };
          },
        },
        processGroupId: 7320,
        processId: 7321,
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
}

function createRevisionAgent(): AgentAdapter {
  const revisedPlan = {
    ...plan,
    approach: "Add the missing rollback proof before implementation.",
    approved_by_attempt_id: null,
    created_at: "2026-07-13T10:03:02Z",
    created_by_attempt_id: "placeholder",
    id: "plan-2",
    revision: 2,
    status: "draft" as const,
    validated_at: null,
  };
  return {
    launch: vi.fn(async (request: AgentLaunchRequest) => {
      const submittedPlan = { ...revisedPlan, created_by_attempt_id: request.attemptId };
      const session: AgentSession = {
        cancel: vi.fn(async () => undefined),
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              attempt_id: request.attemptId,
              event: "session_started" as const,
              model: "gpt-test",
              reasoning_effort: "high",
              session_id: "revision-session",
              thread_id: "revision-thread",
              timestamp: "2026-07-13T10:03:01Z",
              turn_id: "revision-turn",
            };
            const decision = await request.onPlanSubmitted?.(submittedPlan);
            if (!decision?.accepted) throw new Error("valid revised Plan was rejected");
            yield {
              attempt_id: request.attemptId,
              event: "plan_reported" as const,
              plan: submittedPlan,
              session_id: "revision-session",
              timestamp: "2026-07-13T10:03:02Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "terminal_result_reported" as const,
              result: {
                actions_requested: [],
                confusions: [],
                evidence: [],
                handoff: reviewResult.handoff,
                status: "plan_ready",
                summary: "Revised Plan is ready for independent review.",
              },
              session_id: "revision-session",
              timestamp: "2026-07-13T10:03:03Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "turn_completed" as const,
              provider_reason: "completed",
              session_id: "revision-session",
              timestamp: "2026-07-13T10:03:04Z",
            };
          },
        },
        processGroupId: 8320,
        processId: 8321,
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
        localBranch: "symphony/org-14",
        repository: input.repository,
        workspacePath,
      };
    },
  };
}

function seedApprovedPlan(): void {
  for (const [id, role, number, terminal] of [
    ["builder-attempt", "implementation", 1, "builder-result"],
    ["review-attempt", "plan_review", 2, "review-result"],
  ] as const) {
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
          change_class, started_at, ended_at, status, terminal_result_id
        ) values (?, 'issue', 'issue-1', ?, ?, ?, 'config-1', 'deep', 'gpt-test', 'high',
          '[]', 'high_risk', 't0', 't1', 'closed', ?)`,
      )
      .run(id, role, number, issueWorkspacePath(workspaceRoot, issue.identifier), terminal);
  }
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
      ) values (
        'issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null,
        'In Progress', 'implementation_after_plan_approval'
      )`,
    )
    .run();
}
