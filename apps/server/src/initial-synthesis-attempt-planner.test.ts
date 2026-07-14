import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  SynthesisResultSchema,
  type SystemJob,
} from "@symphony/contracts";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planInitialSynthesisAttempt } from "./initial-synthesis-attempt-planner.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
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

const job: Extract<SystemJob, { kind: "synthesis" }> = {
  acceptance_criteria: ["Every proposed rule cites durable lessons"],
  config_snapshot_id: "config-1",
  cost_usd: null,
  created_at: "2026-07-13T10:00:00Z",
  ended_at: null,
  final_result_id: null,
  goal: "Synthesize recent lessons",
  id: "synthesis-1",
  input_tokens: 0,
  kind: "synthesis",
  output_tokens: 0,
  parent_work_ref: null,
  repository: "owner/repo",
  started_at: null,
  status: "queued",
  workspace_path: "/tmp/symphony-workspaces/_system/synthesis-synthesis-1",
};

describe("initial synthesis attempt planning", () => {
  it("preflights a deep tracker-free attempt with bounded durable learning inputs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-planner-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
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
    const planned = await planInitialSynthesisAttempt({
      adapter,
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
        workspaceRoot: "/tmp/symphony-workspaces",
      },
      context: {
        activeSynthesisJobs: 1,
        completedIssuesSinceLastSynthesis: 25,
        decayedRuleIds: ["rule-old"],
        lastSynthesisEndedAt: null,
        lessons: [
          {
            created_at: "2026-07-13T09:00:00Z",
            evidence: [{ kind: "commit", sha: "abc1234" }],
            id: "lesson-1",
            source: "review_finding",
            text: "Validate current-head evidence",
            work_ref: { issue_id: "issue-1" },
          },
        ],
        metrics: [
          {
            attemptCount: 2,
            changeClass: "standard",
            costUsd: 1.25,
            inputTokens: 100,
            outputTokens: 50,
            role: "implementation",
          },
        ],
        rules: [
          {
            citation_count: 3,
            id: "rule-1",
            last_cited_at: "2026-07-13T08:00:00Z",
            lesson_ids: ["lesson-1"],
            text: "Require current-head evidence",
          },
        ],
      },
      database: opened.database,
      job,
      maxPromptTokens: 4_000,
      maxRules: 25,
      newId: () => `id-${++sequence}`,
      now: () => "2026-07-13T10:01:00Z",
      serviceRunId: "run-1",
      terminalResultSchema: SynthesisResultSchema,
    });

    expect(adapter.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ["terminal_result", "skills"],
        role: "synthesis",
        terminalResultSchema: SynthesisResultSchema,
      }),
    );
    expect(planned).toMatchObject({
      attemptId: "id-1",
      attemptNumber: 1,
      route: { profile: "deep" },
    });
    expect(planned.prompt).toContain('"lesson-1"');
    expect(planned.prompt).toContain('"rule-old"');
    expect(planned.prompt).toContain('"max_prompt_tokens":4000');
    expect(planned.dispatch).toMatchObject({
      attempt: { role: "synthesis" },
      expectedReadyReason: "system_job_dispatch_required",
      systemJobTransition: { expectedFromStage: "queued", toStage: "running" },
      workRef: { id: "synthesis-1", kind: "system_job" },
    });
    expect(planned.dispatch.reservation.ledgers).toContainEqual({
      amount: 300_000,
      id: "budget:system_job:synthesis-1:tokens",
      version: 1,
    });
    await opened.close();
  });
});
