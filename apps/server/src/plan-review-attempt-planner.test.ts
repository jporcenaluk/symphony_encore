import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  type Issue,
  type Plan,
  PlanReviewResultSchema,
} from "@symphony/contracts";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planHighRiskPlanReviewAttempt } from "./plan-review-attempt-planner.js";

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
  acceptance_criteria: ["Review every high-risk Plan independently"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Dispatch a fresh Plan reviewer.",
  id: "issue-1",
  identifier: "ORG-11",
  labels: ["security"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Review the validated Plan",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/11",
};

const plan: Plan = {
  acceptance_criteria: [
    {
      criterion_id: "criterion-1",
      criterion_text: issue.acceptance_criteria[0] as string,
      planned_evidence: "Plan-review integration coverage",
    },
  ],
  approach: "Review the security-sensitive change.",
  approved_by_attempt_id: null,
  created_at: "2026-07-13T10:01:00Z",
  created_by_attempt_id: "attempt-1",
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

describe("high-risk Plan-review attempt planning", () => {
  it("preflights and charges an economy fresh-context continuation without a tracker intent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-plan-review-planner-"));
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
          'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG-11',
          'config-1', 'deep', 'gpt-test', 'high', '[]', 'high_risk',
          't0', 't1', 'closed', 'result-1'
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

    const planned = await planHighRiskPlanReviewAttempt({
      adapter,
      configSnapshotId: "config-1",
      configuration: {
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
      newId: () => `review-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      plan,
      serviceRunId: "run-1",
      terminalResultSchema: PlanReviewResultSchema,
    });

    expect(adapter.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ["terminal_result", "skills"],
        role: "plan_review",
        terminalResultSchema: PlanReviewResultSchema,
      }),
    );
    expect(planned).toMatchObject({
      attemptId: "review-1",
      attemptNumber: 2,
      estimatedTokens: 100_000,
      estimatedUsd: null,
      route: { model: "gpt-test", profile: "economy", reasoningEffort: "low" },
    });
    expect(planned.prompt).toContain("independent Plan reviewer");
    expect(planned.prompt).toContain('"id":"plan-1"');
    expect(planned.prompt).not.toContain("builder narrative");
    expect(planned.dispatch).toMatchObject({
      attempt: { changeClass: "high_risk", role: "plan_review" },
      claim: { originStage: "In Progress", reason: "plan_review" },
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(planned.dispatch.issueMutation).toBeUndefined();
    expect(planned.dispatch.systemJobTransition).toBeUndefined();
    expect(opened.sqlite.prepare("select count(*) as count from budget_ledgers").get()).toEqual({
      count: 3,
    });
    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 1,
    });
    await opened.close();
  });
});
