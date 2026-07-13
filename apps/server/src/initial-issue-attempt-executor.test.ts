import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentAdapter,
  AgentLaunchRequest,
  AgentPreflightRequest,
  AgentSession,
  TrackerAdapter,
  WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import { issueWorkspacePath } from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  ImplementationOutcomeSchema,
  type Issue,
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

import { executePlannedInitialIssueAttempt } from "./initial-issue-attempt-executor.js";
import { planInitialIssueAttempt } from "./initial-issue-attempt-planner.js";

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
  acceptance_criteria: ["Launch only after the receipt"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Execute a planned attempt.",
  id: "issue-1",
  identifier: "ORG-8",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "org",
  state: "Todo",
  title: "Execute an implementation attempt",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/8",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-attempt-executor-"));
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
    observedAt: "2026-07-13T09:30:00.000Z",
    providerRevision: "revision-7",
    transitionId: "baseline-1",
  });
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function createAgent(order: string[]): AgentAdapter {
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
              reasoning_effort: "medium",
              session_id: "thread-1-turn-1",
              thread_id: "thread-1",
              timestamp: "2026-07-13T10:00:03.000Z",
              turn_id: "turn-1",
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
}

describe("planned initial issue attempt execution", () => {
  it("orders lane receipt, workspace provenance, and durable session launch", async () => {
    const order: string[] = [];
    const agent = createAgent(order);
    let sequence = 0;
    const planned = await planInitialIssueAttempt({
      adapter: agent,
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
        prompt: "Implement {{ issue.title }}.",
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
        rules: "",
        skillRoots: [],
        workspaceRoot,
      },
      database: opened.database,
      issue,
      newId: () => `id-${++sequence}`,
      now: () => "2026-07-13T10:00:00.000Z",
      providerRevision: "revision-7",
      routingFacts: new Set(),
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });
    const tracker = {
      updateIssueLane: vi.fn(async () => {
        order.push("lane");
        return {
          providerRequestId: "request-1",
          responsePayloadHash: "sha256:receipt",
          result: "updated",
          resultRevision: "revision-8",
        };
      }),
    } as unknown as TrackerAdapter;
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      async populateIssueWorkspace(input) {
        order.push("populate");
        const workspacePath = issueWorkspacePath(input.workspaceRoot, input.identifier);
        await mkdir(workspacePath);
        return {
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter",
          createdAt: "2026-07-13T10:00:01.000Z",
          localBranch: "symphony/org-8",
          repository: input.repository,
          workspacePath,
        };
      },
    };

    const bound = await executePlannedInitialIssueAttempt({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      issue,
      newId: () => "failure-result-unused",
      now: () => "2026-07-13T10:00:02.000Z",
      planned,
      repositoryAdapter,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      sourceEnvironment: { GH_TOKEN: "must-not-reach-worker" },
      tracker,
      workspaceRoot,
    });

    expect(order).toEqual(["lane", "populate", "launch"]);
    expect(bound.started.session_id).toBe("thread-1-turn-1");
    expect(agent.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "id-1",
        command: "codex app-server",
        environment: expect.not.objectContaining({ GH_TOKEN: expect.anything() }),
        profile: "standard",
        prompt: "Implement Execute an implementation attempt.",
        title: "issue:issue-1: Execute an implementation attempt",
      }),
    );
    expect(opened.sqlite.prepare("select state, provider_revision from issues").get()).toEqual({
      provider_revision: "revision-8",
      state: "In Progress",
    });
    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "running",
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from workspace_checkouts").get(),
    ).toEqual({ count: 1 });
    expect(opened.sqlite.prepare("select count(*) as count from live_sessions").get()).toEqual({
      count: 1,
    });
  });

  it("closes and settles a charged attempt when workspace preparation fails", async () => {
    const order: string[] = [];
    const agent = createAgent(order);
    let sequence = 0;
    const planned = await planInitialIssueAttempt({
      adapter: agent,
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
        prompt: "Implement {{ issue.title }}.",
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
        rules: "",
        skillRoots: [],
        workspaceRoot,
      },
      database: opened.database,
      issue,
      newId: () => `failed-${++sequence}`,
      now: () => "2026-07-13T10:00:00.000Z",
      providerRevision: "revision-7",
      routingFacts: new Set(),
      serviceRunId: "run-1",
      submitPlanSchema: PlanSchema,
      terminalResultSchema: ImplementationOutcomeSchema,
    });
    const tracker = {
      updateIssueLane: vi.fn(async () => {
        order.push("lane");
        return {
          providerRequestId: "request-1",
          responsePayloadHash: "sha256:receipt",
          result: "updated",
          resultRevision: "revision-8",
        };
      }),
    } as unknown as TrackerAdapter;
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      async populateIssueWorkspace() {
        order.push("populate");
        throw new Error("workspace.populate_failed");
      },
    };

    await expect(
      executePlannedInitialIssueAttempt({
        adapter: agent,
        agentCommand: "codex app-server",
        afterCreateCommand: null,
        allowlistedEnvironmentNames: [],
        beforeRunCommand: null,
        database: opened.database,
        hookTimeoutMs: 60_000,
        issue,
        newId: () => "failure-result-1",
        now: () => "2026-07-13T10:00:02.000Z",
        planned,
        repositoryAdapter,
        safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
        sourceEnvironment: {},
        tracker,
        workspaceRoot,
      }),
    ).rejects.toThrow("workspace.populate_failed");

    expect(order).toEqual(["lane", "populate"]);
    expect(opened.sqlite.prepare("select status, failure_class from attempts").get()).toEqual({
      failure_class: "infrastructure",
      status: "closed",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "launch_failed",
    });
    expect(opened.sqlite.prepare("select reserved, consumed from budget_ledgers").all()).toEqual([
      { consumed: 0, reserved: 0 },
      { consumed: 0, reserved: 0 },
      { consumed: 0, reserved: 0 },
    ]);
    expect(
      opened.sqlite.prepare("select result_kind, payload_json from terminal_results").get(),
    ).toEqual({
      payload_json: expect.stringContaining('"status":"failed"'),
      result_kind: "execution_failure",
    });
  });
});
