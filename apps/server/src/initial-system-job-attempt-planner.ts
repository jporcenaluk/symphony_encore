import {
  type AgentAdapter,
  type AgentPreflightResult,
  resolveRequiredSkills,
  systemJobWorkspacePath,
} from "@symphony/adapters";
import type { AgentAdapterManifest, SystemJob } from "@symphony/contracts";
import {
  type ComputeProfile,
  type ComputeRoute,
  classifyProvisionally,
  estimateUsage,
  selectComputeRoute,
} from "@symphony/domain";
import { renderWorkflowPrompt } from "@symphony/orchestration";
import {
  type DispatchInput,
  listAttemptUsageHistory,
  nextAttemptNumber,
  type OpenedDatabase,
  prepareDispatchBudget,
} from "@symphony/persistence";

import type { InitialIssueAttemptConfiguration } from "./initial-issue-attempt-planner.js";

export interface PlannedInitialSystemJobAttempt {
  attemptId: string;
  attemptNumber: number;
  dispatch: DispatchInput;
  estimatedTokens: number;
  estimatedUsd: number | null;
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planInitialSystemJobAttempt(input: {
  adapter: AgentAdapter;
  configuration: InitialIssueAttemptConfiguration;
  database: OpenedDatabase["database"];
  job: SystemJob;
  newId(): string;
  now(): string;
  serviceRunId: string;
  submitPlanSchema: Readonly<Record<string, unknown>>;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedInitialSystemJobAttempt> {
  if (input.job.kind !== "repair" || input.job.status !== "queued") {
    throw new Error("system_job_dispatch.job_not_queued_repair");
  }
  const expectedWorkspace = systemJobWorkspacePath(
    input.configuration.workspaceRoot,
    input.job.kind,
    input.job.id,
  );
  if (input.job.workspace_path !== expectedWorkspace) {
    throw new Error("system_job_dispatch.workspace_path_mismatch");
  }
  const manifest = await input.adapter.manifest();
  const resolvedSkills = await resolveRequiredSkills({
    names: input.configuration.requiredSkills,
    roots: input.configuration.skillRoots,
  });
  const preflight = await input.adapter.preflight({
    requiredCapabilities: ["terminal_result", "submit_plan", "skills"],
    requiredSkills: resolvedSkills,
    role: "implementation",
    submitPlanSchema: input.submitPlanSchema,
    terminalResultSchema: input.terminalResultSchema,
  });
  assertPreflightManifest(preflight, manifest);

  const routingFacts = repairRoutingFacts(input.job);
  const configuredRiskFacts = input.configuration.riskFloorRules
    .filter((rule) => rule.roles.includes("implementation") && routingFacts.has(rule.whenFact))
    .map((rule) => rule.id);
  const intrinsicRiskFacts = [...routingFacts].filter((fact) => fact.startsWith("risk."));
  const classification = classifyProvisionally({
    acceptanceCriteriaPresent: input.job.acceptance_criteria.length > 0,
    riskFacts: [...intrinsicRiskFacts, ...configuredRiskFacts],
    standardFacts: ["classification.repair_floor"],
  });
  const route = selectComputeRoute({
    changeClass: classification.changeClass,
    enabledProfiles: input.configuration.enabledProfiles,
    facts: routingFacts,
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "implementation",
    routeProfiles: input.configuration.routeProfiles,
  });

  const attemptId = input.newId();
  const reservationId = input.newId();
  const eventId = input.newId();
  const stageTransitionId = input.newId();
  requireIds([attemptId, reservationId, eventId, stageTransitionId, input.serviceRunId]);
  const workRef = { id: input.job.id, kind: "system_job" as const };
  const attemptNumber = await nextAttemptNumber(input.database, workRef);
  const history = await listAttemptUsageHistory(input.database, {
    limit: input.configuration.historyWindowSamples,
    profile: route.profile,
    role: "implementation",
  });
  const configuredTokens = input.configuration.estimateTokensByProfile[route.profile];
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
  if (!Number.isFinite(nowMs)) throw new Error("system_job_dispatch.timestamp_invalid");
  const expiresAt = new Date(nowMs + input.configuration.leaseTtlMs).toISOString();
  const prompt = renderWorkflowPrompt(input.configuration.prompt, {
    attempt: {
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      compute_profile: route.profile,
      role: "implementation",
    },
    change_class: classification.changeClass,
    issue: {
      acceptance_criteria: input.job.acceptance_criteria,
      id: input.job.id,
      title: input.job.goal,
    },
    plan: null,
    rules: input.configuration.rules,
    system_job: input.job,
    work_ref: `system_job:${input.job.id}`,
  });
  const ledgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    limits: input.configuration.budgetLimits,
    systemJobId: input.job.id,
    updatedAt: now,
  });
  const routingReasons = [...new Set([...classification.reasons, ...route.reasons])];
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber,
      changeClass: classification.changeClass,
      computeProfile: route.profile,
      configSnapshotId: input.job.config_snapshot_id,
      costUsd: null,
      id: attemptId,
      model: route.model,
      priceTableVersion: manifest.price_table?.version ?? null,
      reasoningEffort: route.reasoningEffort,
      role: "implementation",
      routingReasons,
      startedAt: now,
      workspacePath: input.job.workspace_path,
    },
    claim: {
      acquiredAt: now,
      expiresAt,
      holder: input.serviceRunId,
      originStage: "queued",
      reason: "system_job_dispatch",
    },
    expectedReadyReason: "system_job_dispatch_required",
    reservation: { id: reservationId, ledgers },
    systemJobEvent: {
      attemptId,
      changeClass: classification.changeClass,
      computeProfile: route.profile,
      costUsd: null,
      eventName: "dispatch.pending",
      id: eventId,
      payload: {
        adapter_version: manifest.adapter_version,
        model: route.model,
        reasoning_effort: route.reasoningEffort,
        target_stage: "running",
      },
      reasonCode: "system_job_dispatch",
      result: "pending",
      serviceRunId: input.serviceRunId,
      timestamp: now,
      workRef: { system_job_id: input.job.id },
    },
    systemJobTransition: {
      attemptId,
      confirmedExternalRevision: null,
      enteredAt: now,
      expectedFromStage: "queued",
      id: stageTransitionId,
      reason: "system_job_dispatch",
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

function repairRoutingFacts(job: Extract<SystemJob, { kind: "repair" }>): Set<string> {
  const text = `${job.goal}\n${job.acceptance_criteria.join("\n")}`.toLocaleLowerCase("en-US");
  const facts = new Set<string>(["system_job:repair"]);
  if (/\b(?:auth|credential|permission|security|secret|token)\b/u.test(text)) {
    facts.add("risk.repair_security");
  }
  if (/\b(?:data|database|migration|schema)\b/u.test(text)) {
    facts.add("risk.repair_data_migration");
  }
  if (/\b(?:concurrency|deadlock|race)\b/u.test(text)) facts.add("risk.repair_concurrency");
  if (/\b(?:public apis?|breaking|contract)\b/u.test(text)) facts.add("risk.repair_public_api");
  return facts;
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
  if (!price) throw new Error(`system_job_dispatch.price_missing:${model}`);
  return (
    (estimatedTokens * Math.max(price.input_per_million_usd, price.output_per_million_usd)) /
    1_000_000
  );
}

function assertPreflightManifest(
  preflight: AgentPreflightResult,
  manifest: AgentAdapterManifest,
): void {
  if (
    preflight.adapterVersion !== manifest.adapter_version ||
    preflight.protocolSchemaHash !== manifest.protocol.schema_hash ||
    preflight.manifest.adapter_version !== manifest.adapter_version
  ) {
    throw new Error("system_job_dispatch.preflight_manifest_mismatch");
  }
}

function requireIds(values: readonly string[]): void {
  if (values.some((value) => !value)) throw new Error("system_job_dispatch.identity_invalid");
}
