import {
  type AgentAdapter,
  type AgentPreflightResult,
  resolveRequiredSkills,
  systemJobWorkspacePath,
} from "@symphony/adapters";
import type { AgentAdapterManifest, SystemJob } from "@symphony/contracts";
import {
  type ComputeProfile,
  type ComputeRiskFloorRule,
  type ComputeRoute,
  type ComputeRouteProfiles,
  estimateUsage,
  selectComputeRoute,
} from "@symphony/domain";
import {
  type DispatchBudgetLimits,
  type DispatchInput,
  listAttemptUsageHistory,
  nextAttemptNumber,
  type OpenedDatabase,
  prepareDispatchBudget,
  type SynthesisTriggerState,
} from "@symphony/persistence";

export interface SynthesisAttemptConfiguration {
  budgetLimits: DispatchBudgetLimits;
  enabledProfiles: readonly ComputeProfile[];
  estimateTokensByProfile: Readonly<Record<ComputeProfile, number>>;
  historyMinSamples: number;
  historyWindowSamples: number;
  leaseTtlMs: number;
  requiredSkills: readonly string[];
  riskFloorRules: readonly ComputeRiskFloorRule[];
  routeProfiles: ComputeRouteProfiles;
  skillRoots: readonly string[];
  workspaceRoot: string;
}

export interface PlannedInitialSynthesisAttempt {
  attemptId: string;
  attemptNumber: number;
  dispatch: DispatchInput;
  estimatedTokens: number;
  estimatedUsd: number | null;
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planInitialSynthesisAttempt(
  input: {
    adapter: AgentAdapter;
    configuration: SynthesisAttemptConfiguration;
    context: SynthesisTriggerState;
    job: Extract<SystemJob, { kind: "synthesis" }>;
    maxPromptTokens: number;
    maxRules: number;
    expectedReadyReason?:
      | "synthesis_retry_required"
      | "synthesis_rework"
      | "system_job_dispatch_required";
    newId(): string;
    now(): string;
    serviceRunId: string;
    terminalResultSchema: Readonly<Record<string, unknown>>;
  } & { database: OpenedDatabase["database"] },
): Promise<PlannedInitialSynthesisAttempt> {
  if (input.job.status !== "queued" && input.job.status !== "rework") {
    throw new Error("synthesis_dispatch.job_not_dispatchable");
  }
  const expectedReadyReason =
    input.expectedReadyReason ??
    (input.job.status === "queued" ? "system_job_dispatch_required" : "synthesis_retry_required");
  if (
    input.job.workspace_path !==
    systemJobWorkspacePath(input.configuration.workspaceRoot, "synthesis", input.job.id)
  ) {
    throw new Error("synthesis_dispatch.workspace_path_mismatch");
  }
  if (
    !Number.isSafeInteger(input.maxPromptTokens) ||
    input.maxPromptTokens < 1 ||
    !Number.isSafeInteger(input.maxRules) ||
    input.maxRules < 1
  ) {
    throw new Error("synthesis_dispatch.saturation_limit_invalid");
  }
  const manifest = await input.adapter.manifest();
  const requiredSkills = await resolveRequiredSkills({
    names: input.configuration.requiredSkills,
    roots: input.configuration.skillRoots,
  });
  const preflight = await input.adapter.preflight({
    requiredCapabilities: ["terminal_result", "skills"],
    requiredSkills,
    role: "synthesis",
    terminalResultSchema: input.terminalResultSchema,
  });
  assertPreflight(preflight, manifest);
  const route = selectComputeRoute({
    changeClass: "standard",
    enabledProfiles: input.configuration.enabledProfiles,
    facts: new Set(["system_job:synthesis"]),
    heuristicMinimum: "deep",
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "synthesis",
    routeProfiles: input.configuration.routeProfiles,
  });
  if (route.profile !== "deep") throw new Error("synthesis_dispatch.deep_profile_required");
  const attemptId = requiredId(input.newId());
  const reservationId = requiredId(input.newId());
  const eventId = requiredId(input.newId());
  const transitionId = requiredId(input.newId());
  const workRef = { id: input.job.id, kind: "system_job" as const };
  const attemptNumber = await nextAttemptNumber(input.database, workRef);
  const history = await listAttemptUsageHistory(input.database, {
    limit: input.configuration.historyWindowSamples,
    profile: route.profile,
    role: "synthesis",
  });
  const configuredTokens = input.configuration.estimateTokensByProfile.deep;
  const estimatedTokens = estimateUsage({
    configuredEstimate: configuredTokens,
    history: history.map((entry) => entry.totalTokens),
    historyMinSamples: input.configuration.historyMinSamples,
    historyWindowSamples: input.configuration.historyWindowSamples,
  });
  const configuredUsd = configuredCost(manifest, route.model, configuredTokens);
  const costHistory = history.flatMap((entry) => (entry.costUsd === null ? [] : [entry.costUsd]));
  const estimatedUsd =
    configuredUsd === null
      ? null
      : estimateUsage({
          configuredEstimate: configuredUsd,
          history: costHistory,
          historyMinSamples: input.configuration.historyMinSamples,
          historyWindowSamples: input.configuration.historyWindowSamples,
        });
  const now = input.now();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("synthesis_dispatch.timestamp_invalid");
  const ledgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    limits: input.configuration.budgetLimits,
    systemJobId: input.job.id,
    updatedAt: now,
  });
  const prompt = renderPrompt(input);
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber,
      changeClass: "standard",
      computeProfile: route.profile,
      configSnapshotId: input.job.config_snapshot_id,
      costUsd: null,
      id: attemptId,
      model: route.model,
      priceTableVersion: manifest.price_table?.version ?? null,
      reasoningEffort: route.reasoningEffort,
      role: "synthesis",
      routingReasons: [...route.reasons, "learning.synthesis"],
      startedAt: now,
      workspacePath: input.job.workspace_path,
    },
    claim: {
      acquiredAt: now,
      expiresAt: new Date(nowMs + input.configuration.leaseTtlMs).toISOString(),
      holder: input.serviceRunId,
      originStage: input.job.status,
      reason: "synthesis_dispatch",
    },
    expectedReadyReason,
    reservation: { id: reservationId, ledgers },
    systemJobEvent: {
      attemptId,
      changeClass: "standard",
      computeProfile: route.profile,
      costUsd: null,
      eventName: "dispatch.pending",
      id: eventId,
      payload: { model: route.model, target_stage: "running" },
      reasonCode: "learning.synthesis",
      result: "pending",
      serviceRunId: input.serviceRunId,
      timestamp: now,
      workRef: { system_job_id: input.job.id },
    },
    systemJobTransition: {
      attemptId,
      confirmedExternalRevision: null,
      enteredAt: now,
      expectedFromStage: input.job.status,
      id: transitionId,
      reason: "learning.synthesis",
      timestampSource: "observed_estimate",
      toStage: "running",
      workRef,
    },
    workRef,
  };
  return {
    attemptId,
    attemptNumber,
    dispatch,
    estimatedTokens,
    estimatedUsd,
    preflight,
    prompt,
    route,
  };
}

function renderPrompt(input: {
  context: SynthesisTriggerState;
  job: Extract<SystemJob, { kind: "synthesis" }>;
  maxPromptTokens: number;
  maxRules: number;
}): string {
  return [
    "You are the supervised workflow synthesis agent.",
    "Use only the durable lessons, rules, metrics, and repository evidence supplied here.",
    "Report exactly one typed SynthesisResult. Every rule change must cite lesson ids.",
    "At a hard cap, adding a rule requires removing or merging an existing rule.",
    "Do not mutate tracker state or merge repository changes.",
    `SystemJob: ${JSON.stringify(input.job)}`,
    `Learning inputs: ${JSON.stringify({
      decayed_rule_ids: input.context.decayedRuleIds,
      lessons: input.context.lessons,
      metrics: input.context.metrics,
      rules: input.context.rules,
    })}`,
    `Saturation limits: ${JSON.stringify({
      max_prompt_tokens: input.maxPromptTokens,
      max_rules: input.maxRules,
    })}`,
  ].join("\n");
}

function resolvedProfiles(manifest: AgentAdapterManifest) {
  return Object.fromEntries(
    (Object.keys(manifest.profiles) as ComputeProfile[]).map((profile) => [
      profile,
      {
        model: manifest.profiles[profile].model,
        reasoningEffort: manifest.profiles[profile].reasoning_effort,
      },
    ]),
  ) as Record<ComputeProfile, { model: string; reasoningEffort: string }>;
}

function configuredCost(
  manifest: AgentAdapterManifest,
  model: string,
  estimatedTokens: number,
): number | null {
  if (manifest.price_table === null) return null;
  const price = manifest.price_table.models[model];
  if (!price) throw new Error(`synthesis_dispatch.price_missing:${model}`);
  return (
    (estimatedTokens * Math.max(price.input_per_million_usd, price.output_per_million_usd)) /
    1_000_000
  );
}

function assertPreflight(preflight: AgentPreflightResult, manifest: AgentAdapterManifest): void {
  if (
    preflight.adapterVersion !== manifest.adapter_version ||
    preflight.protocolSchemaHash !== manifest.protocol.schema_hash ||
    preflight.role !== "synthesis"
  ) {
    throw new Error("synthesis_dispatch.preflight_mismatch");
  }
}

function requiredId(id: string): string {
  if (!id) throw new Error("synthesis_dispatch.identity_invalid");
  return id;
}
