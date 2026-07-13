import {
  type AgentAdapter,
  type AgentPreflightResult,
  issueWorkspacePath,
  resolveRequiredSkills,
} from "@symphony/adapters";
import type { AgentAdapterManifest, Issue, Plan, PlanReviewResult } from "@symphony/contracts";
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
} from "@symphony/persistence";

export type ImplementationContinuationMode = "approved_plan" | "plan_revision";

export interface ImplementationContinuationConfiguration {
  attemptTokenCap: number;
  budgetLimits: DispatchBudgetLimits;
  enabledProfiles: readonly ComputeProfile[];
  estimateTokensByProfile: Readonly<Record<ComputeProfile, number>>;
  historyMinSamples: number;
  historyWindowSamples: number;
  leaseTtlMs: number;
  maxTurns: number;
  requiredSkills: readonly string[];
  riskFloorRules: readonly ComputeRiskFloorRule[];
  routeProfiles: ComputeRouteProfiles;
  skillRoots: readonly string[];
  workspaceRoot: string;
}

export interface PlannedImplementationContinuation {
  attemptId: string;
  attemptNumber: number;
  dispatch: DispatchInput;
  estimatedTokens: number;
  estimatedUsd: number | null;
  expectedReadyReason: "implementation_after_plan_approval" | "plan_revision_required";
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planImplementationContinuation(input: {
  adapter: AgentAdapter;
  configSnapshotId: string;
  configuration: ImplementationContinuationConfiguration;
  database: OpenedDatabase["database"];
  issue: Issue;
  mode: ImplementationContinuationMode;
  newId(): string;
  now(): string;
  plan: Plan;
  reviewResult: PlanReviewResult;
  serviceRunId: string;
  submitPlanSchema: Readonly<Record<string, unknown>>;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedImplementationContinuation> {
  assertSource(input.issue, input.plan, input.reviewResult, input.mode);
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
  const route = selectComputeRoute({
    changeClass: "high_risk",
    enabledProfiles: input.configuration.enabledProfiles,
    facts: new Set(input.plan.risk_facts),
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "implementation",
    routeProfiles: input.configuration.routeProfiles,
  });
  const attemptId = input.newId();
  const reservationId = input.newId();
  requireIds([attemptId, reservationId]);
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
  if (!Number.isFinite(nowMs)) throw new Error("implementation_continuation.timestamp_invalid");
  const leaseExpiresAt = new Date(nowMs + input.configuration.leaseTtlMs).toISOString();
  const budgetLedgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    issueId: input.issue.id,
    limits: input.configuration.budgetLimits,
    updatedAt: now,
  });
  const prompt = renderPrompt(input);
  const expectedReadyReason =
    input.mode === "approved_plan"
      ? "implementation_after_plan_approval"
      : "plan_revision_required";
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber,
      changeClass: "high_risk",
      computeProfile: route.profile,
      configSnapshotId: input.configSnapshotId,
      costUsd: null,
      id: attemptId,
      model: route.model,
      priceTableVersion: manifest.price_table?.version ?? null,
      reasoningEffort: route.reasoningEffort,
      role: "implementation",
      routingReasons: route.reasons,
      startedAt: now,
      workspacePath: issueWorkspacePath(input.configuration.workspaceRoot, input.issue.identifier),
    },
    claim: {
      acquiredAt: now,
      expiresAt: leaseExpiresAt,
      holder: input.serviceRunId,
      originStage: "In Progress",
      reason: "implementation_continuation",
    },
    reservation: {
      id: reservationId,
      ledgers: budgetLedgers.map((ledger) => ({ ...ledger })),
    },
    workRef,
  };
  return {
    attemptId,
    attemptNumber,
    dispatch,
    estimatedTokens,
    estimatedUsd,
    expectedReadyReason,
    preflight,
    prompt,
    route,
  };
}

function assertSource(
  issue: Issue,
  plan: Plan,
  reviewResult: PlanReviewResult,
  mode: ImplementationContinuationMode,
): void {
  const workMatches = "issue_id" in plan.work_ref && plan.work_ref.issue_id === issue.id;
  const reviewMatches = reviewResult.plan_revision === plan.revision;
  const modeMatches =
    mode === "approved_plan"
      ? plan.status === "approved" &&
        plan.approved_by_attempt_id !== null &&
        reviewResult.decision === "approve"
      : plan.status === "rejected" && reviewResult.decision === "needs_rework";
  if (issue.state !== "In Progress" || !workMatches || !reviewMatches || !modeMatches) {
    throw new Error("implementation_continuation.source_invalid");
  }
}

function renderPrompt(input: {
  configuration: Pick<ImplementationContinuationConfiguration, "attemptTokenCap" | "maxTurns">;
  mode: ImplementationContinuationMode;
  plan: Plan;
  reviewResult: PlanReviewResult;
}): string {
  const currentPlanState =
    input.mode === "approved_plan"
      ? input.plan
      : { revision: input.plan.revision, status: input.plan.status };
  return [
    "Continue implementation from durable orchestrator state in this existing workspace.",
    `Current Plan state: ${JSON.stringify(currentPlanState)}`,
    `Review findings: ${JSON.stringify(input.reviewResult.findings)}`,
    `Factual handoff: ${JSON.stringify(input.reviewResult.handoff)}`,
    `Last verification output: ${JSON.stringify(input.reviewResult.handoff.commands)}`,
    `Unmet acceptance criteria: ${JSON.stringify(input.reviewResult.handoff.open_items)}`,
    `Remaining turn budget: ${input.configuration.maxTurns}`,
    `Remaining token budget: ${input.configuration.attemptTokenCap}`,
    "You must submit a Plan revision before further action when planned paths, verification, size, or risks change.",
    input.mode === "plan_revision"
      ? "First submit a revised Plan that resolves every blocking review finding; do not change code before it is accepted."
      : "Implement the approved Plan and report a typed implementation outcome.",
  ].join("\n");
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
  if (!price) throw new Error(`implementation_continuation.price_missing:${model}`);
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
    throw new Error("implementation_continuation.preflight_manifest_mismatch");
  }
}

function requireIds(ids: readonly string[]): void {
  if (ids.some((id) => !id)) throw new Error("implementation_continuation.identity_invalid");
}
