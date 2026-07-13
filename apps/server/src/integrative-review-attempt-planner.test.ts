import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import { type AgentAdapterManifest, type Issue, ReviewResultSchema } from "@symphony/contracts";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planIntegrativeReviewAttempt } from "./integrative-review-attempt-planner.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-v2:test",
  capabilities: ["terminal_result", "skills"],
  price_table: null,
  profiles: {
    deep: { model: "gpt-test", reasoning_effort: "high" },
    economy: { model: "gpt-test", reasoning_effort: "low" },
    standard: { model: "gpt-test", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:protocol" },
};

const issue: Issue = {
  acceptance_criteria: ["Review the immutable implementation"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Run an independent integrative review.",
  id: "issue-1",
  identifier: "ORG-21",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Review implementation",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/21",
};

describe("integrative review planning", () => {
  it("preflights and reserves a standard fresh-context reviewer with factual evidence only", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-review-planner-"));
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
          'implementation-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG-21',
          'config-1', 'standard', 'gpt-test', 'medium', '[]', 'standard',
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
        submitPlanSchema: null,
        terminalResultSchema: request.terminalResultSchema,
      })),
    };
    let sequence = 0;
    const planned = await planIntegrativeReviewAttempt({
      adapter,
      configSnapshotId: "config-1",
      configuration: configuration(),
      context: {
        baseSha: "abc1234",
        changeClass: "standard",
        changedFiles: ["src/worker.ts"],
        diff: "diff --git a/src/worker.ts b/src/worker.ts",
        patchIdentity: "sha256:patch",
        repositoryDocs: [{ content: "# Repository rules", path: "AGENTS.md" }],
        targetSha: "def5678",
        verificationRecordId: "verification-1",
      },
      database: opened.database,
      issue,
      newId: () => `review-${++sequence}`,
      now: () => "2026-07-13T10:03:00Z",
      serviceRunId: "run-1",
      terminalResultSchema: ReviewResultSchema,
    });

    expect(adapter.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "integrative_review",
        terminalResultSchema: ReviewResultSchema,
      }),
    );
    expect(planned).toMatchObject({
      attemptId: "review-1",
      attemptNumber: 2,
      estimatedTokens: 200_000,
      route: { profile: "standard", reasoningEffort: "medium" },
    });
    expect(planned.prompt).toContain("fresh-context integrative reviewer");
    expect(planned.prompt).toContain("sha256:patch");
    expect(planned.prompt).toContain("src/worker.ts");
    expect(planned.prompt).not.toContain("Implementation is ready for review");
    expect(planned.dispatch).toMatchObject({
      attempt: { changeClass: "standard", role: "integrative_review" },
      claim: { reason: "integrative_review" },
      workRef: { id: "issue-1", kind: "issue" },
    });
    await opened.close();
  });
});

function configuration() {
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
    requiredSkills: [] as string[],
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
    skillRoots: [] as string[],
    workspaceRoot: "/tmp/work",
  };
}
