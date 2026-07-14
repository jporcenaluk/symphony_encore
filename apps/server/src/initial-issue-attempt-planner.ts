import {
  type AgentAdapter,
  type AgentPreflightResult,
  issueWorkspacePath,
  resolveRequiredSkills,
} from "@symphony/adapters";
import type { AgentAdapterManifest, Issue } from "@symphony/contracts";
import {
  type ComputeProfile,
  type ComputeRiskFloorRule,
  type ComputeRoute,
  type ComputeRouteProfiles,
  classifyProvisionally,
  estimateUsage,
  selectComputeRoute,
} from "@symphony/domain";
import { renderWorkflowPrompt } from "@symphony/orchestration";
import {
  type DispatchBudgetLimits,
  listAttemptUsageHistory,
  nextAttemptNumber,
  type OpenedDatabase,
  prepareDispatchBudget,
} from "@symphony/persistence";

import { composeInitialIssueDispatch, type InitialIssueDispatch } from "./issue-dispatch-record.js";

export interface InitialIssueAttemptConfiguration {
  budgetLimits: DispatchBudgetLimits;
  enabledProfiles: readonly ComputeProfile[];
  estimateTokensByProfile: Readonly<Record<ComputeProfile, number>>;
  historyMinSamples: number;
  historyWindowSamples: number;
  leaseTtlMs: number;
  prompt: string;
  requiredSkills: readonly string[];
  riskFloorRules: readonly ComputeRiskFloorRule[];
  routeProfiles: ComputeRouteProfiles;
  rules: string;
  skillRoots: readonly string[];
  workspaceRoot: string;
}

export interface PlannedInitialIssueAttempt {
  attemptId: string;
  attemptNumber: number;
  estimatedTokens: number;
  estimatedUsd: number | null;
  preflight: AgentPreflightResult;
  prompt: string;
  record: InitialIssueDispatch;
  route: ComputeRoute;
}

export async function planInitialIssueAttempt(input: {
  adapter: AgentAdapter;
  configSnapshotId: string;
  configuration: InitialIssueAttemptConfiguration;
  database: OpenedDatabase["database"];
  issue: Issue;
  newId(): string;
  now(): string;
  providerRevision: string;
  routingFacts: ReadonlySet<string>;
  serviceRunId: string;
  submitPlanSchema: Readonly<Record<string, unknown>>;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedInitialIssueAttempt> {
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

  const matchingRiskFacts = input.configuration.riskFloorRules
    .filter(
      (rule) => rule.roles.includes("implementation") && input.routingFacts.has(rule.whenFact),
    )
    .map((rule) => rule.id);
  const classification = classifyProvisionally({
    acceptanceCriteriaPresent: input.issue.acceptance_criteria.length > 0,
    riskFacts: matchingRiskFacts,
    standardFacts: [],
  });
  const route = selectComputeRoute({
    changeClass: classification.changeClass,
    enabledProfiles: input.configuration.enabledProfiles,
    facts: input.routingFacts,
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "implementation",
    routeProfiles: input.configuration.routeProfiles,
  });

  const attemptId = input.newId();
  const reservationId = input.newId();
  const authorizationId = input.newId();
  const eventId = input.newId();
  const intentId = input.newId();
  const stageTransitionId = input.newId();
  requireIds([attemptId, reservationId, authorizationId, eventId, intentId, stageTransitionId]);
  const workRef = { id: input.issue.id, kind: "issue" as const };
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
  if (!Number.isFinite(nowMs)) throw new Error("dispatch_planning.timestamp_invalid");
  const leaseExpiresAt = new Date(nowMs + input.configuration.leaseTtlMs).toISOString();
  const workspacePath = issueWorkspacePath(
    input.configuration.workspaceRoot,
    input.issue.identifier,
  );
  const prompt = renderWorkflowPrompt(input.configuration.prompt, {
    attempt: {
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      compute_profile: route.profile,
      role: "implementation",
    },
    change_class: classification.changeClass,
    issue: input.issue,
    plan: null,
    rules: input.configuration.rules,
    system_job: null,
    work_ref: `issue:${input.issue.id}`,
  });
  const budgetLedgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    issueId: input.issue.id,
    limits: input.configuration.budgetLimits,
    updatedAt: now,
  });
  const record = composeInitialIssueDispatch({
    attemptId,
    attemptNumber,
    authorizationId,
    budgetLedgers,
    changeClass: classification.changeClass,
    classificationReasons: classification.reasons,
    configSnapshotId: input.configSnapshotId,
    eventId,
    intentId,
    issue: input.issue,
    leaseExpiresAt,
    manifest,
    now,
    providerRevision: input.providerRevision,
    reservationId,
    route,
    serviceRunId: input.serviceRunId,
    stageTransitionId,
    workspacePath,
  });
  return {
    attemptId,
    attemptNumber,
    estimatedTokens,
    estimatedUsd,
    preflight,
    prompt,
    record,
    route,
  };
}

function resolvedProfiles(manifest: AgentAdapterManifest) {
  return {
    deep: {
      model: manifest.profiles.deep.model,
      reasoningEffort: manifest.profiles.deep.reasoning_effort,
    },
    economy: {
      model: manifest.profiles.economy.model,
      reasoningEffort: manifest.profiles.economy.reasoning_effort,
    },
    standard: {
      model: manifest.profiles.standard.model,
      reasoningEffort: manifest.profiles.standard.reasoning_effort,
    },
  };
}

function configuredCost(
  manifest: AgentAdapterManifest,
  model: string,
  estimatedTokens: number,
): number | null {
  if (manifest.price_table === null) return null;
  const price = manifest.price_table.models[model];
  if (!price) throw new Error(`dispatch_planning.price_missing:${model}`);
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
    preflight.protocolSchemaHash !== manifest.protocol.schema_hash
  ) {
    throw new Error("dispatch_planning.preflight_manifest_mismatch");
  }
}

function requireIds(ids: readonly string[]): void {
  if (ids.some((id) => !id)) throw new Error("dispatch_planning.identity_invalid");
}
