import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  ImplementationOutcomeSchema,
  type Issue,
  type Plan,
  type PlanReviewResult,
  PlanSchema,
} from "@symphony/contracts";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planImplementationContinuation } from "./implementation-continuation-planner.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

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
  acceptance_criteria: ["Implement the reviewed high-risk change"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "ORIGINAL BUILDER PROMPT MUST NOT RETURN",
  id: "issue-1",
  identifier: "ORG-13",
  labels: ["security"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Continue the reviewed Plan",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/13",
};

const plan: Plan = {
  acceptance_criteria: [
    {
      criterion_id: "criterion-1",
      criterion_text: issue.acceptance_criteria[0] as string,
      planned_evidence: "Run the lifecycle tests",
    },
  ],
  approach: "Apply the reviewed change with rollback coverage.",
  approved_by_attempt_id: "review-attempt",
  created_at: "2026-07-13T10:01:00Z",
  created_by_attempt_id: "builder-attempt",
  estimated_changed_lines: 50,
  estimated_files: 2,
  id: "plan-1",
  proposed_paths: ["apps/server/src/auth.ts"],
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
    decisions_fixed: ["Preserve rollback behavior"],
    files_changed: [],
    goal: issue.title,
    open_items: issue.acceptance_criteria,
    revision: "abc1234",
  },
  plan_revision: 1,
};

describe("implementation continuation planning", () => {
  it.each([
    {
      changeClass: "high_risk" as const,
      expectedReadyReason: "implementation_after_plan_approval",
      expectedProfile: "deep",
      mode: "approved_plan" as const,
      sourcePlan: plan,
      sourceResult: reviewResult,
    },
    {
      changeClass: "high_risk" as const,
      expectedReadyReason: "plan_revision_required",
      expectedProfile: "deep",
      mode: "plan_revision" as const,
      sourcePlan: { ...plan, approved_by_attempt_id: null, status: "rejected" as const },
      sourceResult: {
        ...reviewResult,
        decision: "needs_rework" as const,
        findings: [
          {
            behavior: "Rollback evidence is missing",
            blocking: true as const,
            evidence: [{ kind: "file" as const, path: "PLAN.md" }],
            id: "finding-1",
            severity: "high" as const,
          },
        ],
      },
    },
    {
      changeClass: "standard" as const,
      expectedReadyReason: "no_progress_retry",
      expectedProfile: "standard",
      mode: "implementation_retry" as const,
      retrySource: {
        findings: [],
        handoff: reviewResult.handoff,
        kind: "retry" as const,
        reason: "no_progress_retry" as const,
        routingFacts: ["risk.concurrency"],
        summary: "The previous attempt made no progress.",
      },
      sourcePlan: null,
    },
    {
      changeClass: "standard" as const,
      expectedReadyReason: "review_rework",
      expectedProfile: "standard",
      mode: "review_rework" as const,
      sourcePlan: { ...plan, approved_by_attempt_id: null, status: "validated" as const },
      sourceResult: {
        ...reviewResult,
        decision: "needs_rework" as const,
        findings: [
          {
            behavior: "Retry cleanup can discard a committed result",
            blocking: true as const,
            evidence: [{ kind: "file" as const, path: "src/worker.ts" }],
            id: "finding-review-1",
            severity: "high" as const,
          },
        ],
      },
    },
  ])("plans a deep factual $mode continuation", async (source) => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-implementation-continuation-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
          change_class, started_at, ended_at, status, terminal_result_id
        ) values (
          'builder-attempt', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG-13',
          'config-1', 'deep', 'gpt-test', 'high', '[]', 'high_risk',
          't0', 't1', 'closed', 'builder-result'
        )`,
      )
      .run();
    const adapter: AgentAdapter = {
      launch: vi.fn(),
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
    let sequence = 0;

    const planned = await planImplementationContinuation({
      adapter,
      changeClass: source.changeClass,
      configSnapshotId: "config-1",
      configuration: {
        attemptTokenCap: 400_000,
        budgetLimits: {
          attemptTokens: 400_000,
          attemptUsd: 5,
          fleetTokens: 10_000_000,
          fleetUsd: 50,
          issueTokens: 2_000_000,
          issueUsd: 10,
        },
        enabledProfiles: ["economy", "standard", "deep"],
        estimateTokensByProfile: { deep: 300_000, economy: 100_000, standard: 200_000 },
        historyMinSamples: 10,
        historyWindowSamples: 50,
        leaseTtlMs: 120_000,
        maxTurns: 8,
        requiredSkills: [],
        riskFloorRules: [],
        routeProfiles: {
          adjudication: "deep",
          implementation: { high_risk: "deep", standard: "standard", trivial: "economy" },
          integrative_review: "standard",
          plan_review: "economy",
          specialist_review: "deep",
          synthesis: "deep",
        },
        skillRoots: [],
        workspaceRoot: "/tmp/work",
      },
      database: opened.database,
      issue,
      mode: source.mode,
      newId: () => `continuation-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan: source.sourcePlan,
      source:
        "retrySource" in source
          ? source.retrySource
          : { kind: "review", result: source.sourceResult },
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });

    expect(adapter.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ["terminal_result", "submit_plan", "skills"],
        role: "implementation",
      }),
    );
    expect(planned).toMatchObject({
      attemptNumber: 2,
      expectedReadyReason: source.expectedReadyReason,
      route: { profile: source.expectedProfile },
    });
    expect(planned.prompt).toContain("Remaining turn budget: 8");
    expect(planned.prompt).toContain("Remaining token budget: 400000");
    expect(planned.prompt).toContain("submit a Plan revision");
    expect(planned.prompt).toContain("make verify-fast");
    expect(planned.prompt).not.toContain(issue.description);
    expect(planned.prompt).not.toContain("builder narrative");
    if (source.mode === "approved_plan") {
      expect(planned.prompt).toContain(plan.approach);
    } else if (source.mode === "plan_revision") {
      expect(planned.prompt).toContain("Rollback evidence is missing");
      expect(planned.prompt).not.toContain(plan.approach);
    } else if (source.mode === "review_rework") {
      expect(planned.prompt).toContain("Retry cleanup can discard a committed result");
      expect(planned.prompt).toContain("Resolve every blocking review finding");
      expect(planned.prompt).toContain(plan.approach);
    } else {
      expect(planned.prompt).toContain('"status":"not_submitted"');
      expect(planned.prompt).toContain("previous attempt made no progress");
      expect(planned.prompt).not.toContain(plan.approach);
    }
    expect(planned.dispatch).toMatchObject({
      attempt: { changeClass: source.changeClass, role: "implementation" },
      claim: { originStage: "In Progress", reason: "implementation_continuation" },
    });
    await opened.close();
  });
});
