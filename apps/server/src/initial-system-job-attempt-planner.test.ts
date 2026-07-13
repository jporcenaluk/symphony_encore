import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  ImplementationOutcomeSchema,
  PlanSchema,
  type SystemJob,
} from "@symphony/contracts";
import { applyMigrations, type OpenedDatabase, openDatabase } from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planInitialSystemJobAttempt } from "./initial-system-job-attempt-planner.js";

let directory: string;
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

const job: SystemJob = {
  acceptance_criteria: ["Restore passing post-merge checks"],
  config_snapshot_id: "config-1",
  cost_usd: null,
  created_at: "2026-07-13T10:00:00Z",
  ended_at: null,
  final_result_id: null,
  goal: "Repair failed merge without changing public APIs",
  id: "repair-1",
  input_tokens: 0,
  kind: "repair",
  output_tokens: 0,
  parent_work_ref: { issue_id: "issue-1" },
  repository: "owner/repo",
  started_at: null,
  status: "queued",
  workspace_path: "/tmp/symphony-workspaces/_system/repair-repair-1",
};

const configuration = {
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
  prompt: "Repair {{ system_job.goal }} as {{ change_class }} for {{ work_ref }}.",
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
  rules: "Run the failed check before editing.",
  skillRoots: [] as string[],
  workspaceRoot: "/tmp/symphony-workspaces",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-system-job-planner-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function adapter(): AgentAdapter {
  return {
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
}

describe("initial repair SystemJob attempt planning", () => {
  it("pins a standard-or-higher tracker-free dispatch with a SystemJob budget and stage transition", async () => {
    let sequence = 0;
    const planned = await planInitialSystemJobAttempt({
      adapter: adapter(),
      configuration,
      database: opened.database,
      job,
      newId: () => `id-${++sequence}`,
      now: () => "2026-07-13T10:01:00Z",
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });

    expect(planned).toMatchObject({
      attemptId: "id-1",
      attemptNumber: 1,
      prompt:
        "Repair Repair failed merge without changing public APIs as high_risk for system_job:repair-1.",
      route: { profile: "deep" },
    });
    expect(planned.dispatch).toMatchObject({
      expectedReadyReason: "system_job_dispatch_required",
      systemJobTransition: {
        expectedFromStage: "queued",
        toStage: "running",
        workRef: { id: "repair-1", kind: "system_job" },
      },
      workRef: { id: "repair-1", kind: "system_job" },
    });
    expect(planned.dispatch).not.toHaveProperty("issueMutation");
    expect(planned.dispatch.reservation.ledgers).toContainEqual({
      amount: 300_000,
      id: "budget:system_job:repair-1:tokens",
      version: 1,
    });
  });
});
