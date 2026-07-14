import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentPreflightRequest } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  ImplementationOutcomeSchema,
  type Issue,
  PlanSchema,
} from "@symphony/contracts";
import { applyMigrations, type OpenedDatabase, openDatabase } from "@symphony/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planInitialIssueAttempt } from "./initial-issue-attempt-planner.js";

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

const issue: Issue = {
  acceptance_criteria: ["The launch request is pinned"],
  assignee_id: "operator-1",
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Exercise the initial dispatch path.",
  id: "issue-1",
  identifier: "ORG-7",
  labels: ["security"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "org",
  state: "Todo",
  title: "Plan an implementation attempt",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/7",
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
  prompt:
    "Implement {{ issue.title }} as {{ change_class }} attempt {{ attempt.attempt_number }} for {{ work_ref }}.\n{{ rules }}",
  requiredSkills: [],
  riskFloorRules: [
    {
      id: "risk.security_auth",
      minimumProfile: "deep" as const,
      roles: ["implementation" as const],
      whenFact: "label:security",
    },
  ],
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
  rules: "1. Run verification early and often.",
  skillRoots: [] as string[],
  workspaceRoot: "/tmp/symphony-workspaces",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-attempt-planner-"));
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

function adapter(
  preflightFailure?: Error,
  suppliedManifest: AgentAdapterManifest = manifest,
): AgentAdapter {
  return {
    launch: vi.fn(),
    manifest: vi.fn(async () => suppliedManifest),
    preflight: vi.fn(async (request: AgentPreflightRequest) => {
      if (preflightFailure) throw preflightFailure;
      return {
        adapterVersion: suppliedManifest.adapter_version,
        manifest: suppliedManifest,
        protocolSchemaHash: suppliedManifest.protocol.schema_hash,
        resolvedSkills: request.requiredSkills,
        role: request.role,
        submitPlanSchema: request.submitPlanSchema ?? null,
        terminalResultSchema: request.terminalResultSchema,
      };
    }),
  };
}

describe("initial issue attempt planning", () => {
  it("preflights before charge and pins class, route, budget, prompt, and receipt intent", async () => {
    const target = adapter();
    let sequence = 0;
    const planned = await planInitialIssueAttempt({
      adapter: target,
      configSnapshotId: "config-1",
      configuration,
      database: opened.database,
      issue,
      newId: () => `id-${++sequence}`,
      now: () => "2026-07-13T10:00:00.000Z",
      providerRevision: "revision-7",
      routingFacts: new Set(["label:security"]),
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });

    expect(target.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ["terminal_result", "submit_plan", "skills"],
        requiredSkills: [],
        role: "implementation",
        submitPlanSchema: PlanSchema,
        terminalResultSchema: ImplementationOutcomeSchema,
      }),
    );
    expect(planned).toMatchObject({
      attemptId: "id-1",
      attemptNumber: 1,
      estimatedTokens: 300_000,
      estimatedUsd: null,
      prompt:
        "Implement Plan an implementation attempt as high_risk attempt 1 for issue:issue-1.\n1. Run verification early and often.",
      route: { model: "gpt-test", profile: "deep", reasoningEffort: "high" },
    });
    expect(planned.record.dispatch).toMatchObject({
      attempt: {
        attemptNumber: 1,
        changeClass: "high_risk",
        id: "id-1",
        routingReasons: ["risk.security_auth", "route.implementation.high_risk"],
      },
      reservation: { id: "id-2" },
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(planned.record.dispatch.reservation.ledgers).toHaveLength(3);
    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select count(*) as count from budget_ledgers").get()).toEqual({
      count: 3,
    });
  });

  it("does not create budget ledgers when adapter preflight fails", async () => {
    await expect(
      planInitialIssueAttempt({
        adapter: adapter(new Error("configuration.agent_capability_missing:submit_plan")),
        configSnapshotId: "config-1",
        configuration,
        database: opened.database,
        issue,
        newId: () => "unused",
        now: () => "2026-07-13T10:00:00.000Z",
        providerRevision: "revision-7",
        routingFacts: new Set(),
        serviceRunId: "run-1",
        submitPlanSchema: PlanSchema,
        terminalResultSchema: ImplementationOutcomeSchema,
      }),
    ).rejects.toThrow("configuration.agent_capability_missing:submit_plan");
    expect(opened.sqlite.prepare("select count(*) as count from budget_ledgers").get()).toEqual({
      count: 0,
    });
  });

  it("reserves conservative USD cost for a priced selected model", async () => {
    const pricedManifest: AgentAdapterManifest = {
      ...manifest,
      price_table: {
        models: {
          "gpt-test": {
            cached_input_per_million_usd: 0.5,
            input_per_million_usd: 1,
            output_per_million_usd: 4,
          },
        },
        version: "prices-1",
      },
    };
    let sequence = 0;
    const planned = await planInitialIssueAttempt({
      adapter: adapter(undefined, pricedManifest),
      configSnapshotId: "config-1",
      configuration,
      database: opened.database,
      issue,
      newId: () => `priced-${++sequence}`,
      now: () => "2026-07-13T10:00:00.000Z",
      providerRevision: "revision-7",
      routingFacts: new Set(["label:security"]),
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });

    expect(planned.estimatedUsd).toBe(1.2);
    expect(planned.record.dispatch.reservation.ledgers).toHaveLength(6);
    expect(
      planned.record.dispatch.reservation.ledgers.filter((ledger) => ledger.id.endsWith(":usd")),
    ).toEqual([
      { amount: 1.2, id: "budget:attempt:priced-1:usd", version: 1 },
      { amount: 1.2, id: "budget:issue:issue-1:usd", version: 1 },
      { amount: 1.2, id: "budget:fleet:rolling_24h:usd", version: 1 },
    ]);
  });
});
