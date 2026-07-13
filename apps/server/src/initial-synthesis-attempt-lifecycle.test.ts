import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentAdapter,
  AgentLaunchRequest,
  AgentPreflightRequest,
  WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import {
  type AgentAdapterManifest,
  SynthesisResultSchema,
  type SystemJob,
} from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import {
  applyMigrations,
  loadSystemJob,
  openDatabase,
  queueSynthesisSystemJob,
} from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startPlannedInitialSynthesisAttemptLifecycle } from "./initial-synthesis-attempt-lifecycle.js";
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

describe("initial synthesis attempt lifecycle", () => {
  it("commits dispatch before launch and closes a typed no-change result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-lifecycle-"));
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
        ) values ('run-1', 'test', 'host-1', 't0', 'ready', 'config-1', 'test')`,
      )
      .run();
    await queueSynthesisSystemJob(opened.database, {
      acceptanceCriteria: ["Every proposed rule cites durable lessons"],
      configSnapshotId: "config-1",
      createdAt: "2026-07-13T10:00:00Z",
      goal: "Synthesize recent lessons",
      id: "synthesis-1",
      repository: "owner/repo",
      serviceRunId: "run-1",
      transitionId: "stage-queued",
      trigger: "interval",
      workspacePath: path.join(workspaceRoot, "_system", "synthesis-synthesis-1"),
    });
    const job = (await loadSystemJob(opened.database, "synthesis-1")) as Extract<
      SystemJob,
      { kind: "synthesis" }
    >;
    let plannedAttemptId = "";
    const launch = vi.fn(async (request: AgentLaunchRequest) => {
      expect(
        opened.sqlite
          .prepare("select mode, reason from claims where work_ref_id = 'synthesis-1'")
          .get(),
      ).toEqual({ mode: "Running", reason: "synthesis_dispatch" });
      return {
        cancel: vi.fn(async () => undefined),
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              attempt_id: request.attemptId,
              event: "session_started" as const,
              model: "gpt-test",
              reasoning_effort: "high",
              session_id: "session-1",
              thread_id: "thread-1",
              timestamp: "2026-07-13T10:01:01Z",
              turn_id: "turn-1",
            };
            yield {
              attempt_id: request.attemptId,
              event: "terminal_result_reported" as const,
              result: {
                cited_lesson_ids: [],
                decision: "no_change",
                evidence: [{ kind: "commit", sha: "abc1234" }],
                handoff: {
                  acceptance_criteria: job.acceptance_criteria,
                  commands: [],
                  decisions_fixed: [],
                  files_changed: [],
                  goal: job.goal,
                  open_items: [],
                  revision: "abc1234",
                },
                rule_changes: [],
              },
              session_id: "session-1",
              timestamp: "2026-07-13T10:01:02Z",
            };
            yield {
              attempt_id: request.attemptId,
              event: "turn_completed" as const,
              provider_reason: "completed",
              session_id: "session-1",
              timestamp: "2026-07-13T10:01:03Z",
            };
          },
        },
        processGroupId: 7000,
        processId: 7001,
        waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
      };
    });
    const agent: AgentAdapter = {
      launch,
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
    const planned = await planInitialSynthesisAttempt({
      adapter: agent,
      configuration: configuration(workspaceRoot),
      context: {
        activeSynthesisJobs: 1,
        completedIssuesSinceLastSynthesis: 25,
        decayedRuleIds: [],
        lastSynthesisEndedAt: null,
        lessons: [],
        metrics: [],
        rules: [],
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
    plannedAttemptId = planned.attemptId;
    const repositoryAdapter: WorkspaceRepositoryAdapter = {
      populateIssueWorkspace: vi.fn(async () => {
        throw new Error("issue workspace not expected");
      }),
      populateSystemJobWorkspace: vi.fn(async (request) => {
        const workspacePath = path.join(request.workspaceRoot, "_system", "synthesis-synthesis-1");
        await mkdir(workspacePath, { recursive: true });
        return {
          baseRef: "main",
          baseSha: "abc1234",
          checkoutMethod: "trusted_repository_adapter" as const,
          createdAt: "2026-07-13T10:01:00Z",
          localBranch: "symphony/system-synthesis-1",
          repository: "owner/repo",
          workspacePath,
        };
      }),
    };
    const safety = new PersistenceSafetyController(async () => undefined);
    const started = await startPlannedInitialSynthesisAttemptLifecycle({
      adapter: agent,
      agentCommand: "codex app-server",
      afterCreateCommand: null,
      allowlistedEnvironmentNames: [],
      attemptTokenCap: 400_000,
      beforeRunCommand: null,
      database: opened.database,
      hookTimeoutMs: 60_000,
      job,
      maxFailureRetries: 2,
      maxPromptTokens: 4_000,
      maxRetryBackoffMs: 60_000,
      maxRules: 25,
      newId: () => `close-${++sequence}`,
      now: () => "2026-07-13T10:02:00Z",
      planned,
      readWorkspaceRevision: vi.fn(async () => "abc1234"),
      repositoryAdapter,
      retryJitterSample: 0.5,
      safety,
      serviceRunId: "run-1",
      sourceEnvironment: {},
      usdCap: 5,
      workspaceRoot,
    });
    await started.completion;

    expect(launch).toHaveBeenCalledOnce();
    expect(plannedAttemptId).toBe("id-1");
    expect(opened.sqlite.prepare("select status, final_result_id from system_jobs").get()).toEqual({
      final_result_id: expect.any(String),
      status: "done",
    });
    await opened.close();
  });
});

function configuration(workspaceRoot: string) {
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
