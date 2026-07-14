import {
  type AgentAdapter,
  type AgentPreflightResult,
  issueWorkspacePath,
  resolveRequiredSkills,
} from "@symphony/adapters";
import type { AgentAdapterManifest, Issue, Plan, SystemJob } from "@symphony/contracts";
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

export interface PlanReviewAttemptConfiguration {
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

export interface PlannedPlanReviewAttempt {
  attemptId: string;
  attemptNumber: number;
  dispatch: DispatchInput;
  estimatedTokens: number;
  estimatedUsd: number | null;
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planHighRiskPlanReviewAttempt(input: {
  adapter: AgentAdapter;
  configSnapshotId: string;
  configuration: PlanReviewAttemptConfiguration;
  database: OpenedDatabase["database"];
  issue: Issue | Extract<SystemJob, { kind: "repair" }>;
  newId(): string;
  now(): string;
  plan: Plan;
  serviceRunId: string;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedPlanReviewAttempt> {
  assertReviewTarget(input.issue, input.plan);
  const manifest = await input.adapter.manifest();
  const resolvedSkills = await resolveRequiredSkills({
    names: input.configuration.requiredSkills,
    roots: input.configuration.skillRoots,
  });
  const preflight = await input.adapter.preflight({
    requiredCapabilities: ["terminal_result", "skills"],
    requiredSkills: resolvedSkills,
    role: "plan_review",
    terminalResultSchema: input.terminalResultSchema,
  });
  assertPreflightManifest(preflight, manifest);
  const route = selectComputeRoute({
    changeClass: "high_risk",
    enabledProfiles: input.configuration.enabledProfiles,
    facts: new Set(),
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "plan_review",
    routeProfiles: input.configuration.routeProfiles,
  });
  const attemptId = input.newId();
  const reservationId = input.newId();
  requireIds([attemptId, reservationId]);
  const workRef = workReference(input.issue);
  const attemptNumber = await nextAttemptNumber(input.database, workRef);
  const history = await listAttemptUsageHistory(input.database, {
    limit: input.configuration.historyWindowSamples,
    profile: route.profile,
    role: "plan_review",
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
  if (!Number.isFinite(nowMs)) throw new Error("plan_review.timestamp_invalid");
  const leaseExpiresAt = new Date(nowMs + input.configuration.leaseTtlMs).toISOString();
  const budgetLedgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    limits: input.configuration.budgetLimits,
    ...(workRef.kind === "issue" ? { issueId: workRef.id } : { systemJobId: workRef.id }),
    updatedAt: now,
  });
  const prompt = renderPlanReviewPrompt(input.issue, input.plan);
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
      role: "plan_review",
      routingReasons: route.reasons,
      startedAt: now,
      workspacePath:
        "kind" in input.issue
          ? input.issue.workspace_path
          : issueWorkspacePath(input.configuration.workspaceRoot, input.issue.identifier),
    },
    claim: {
      acquiredAt: now,
      expiresAt: leaseExpiresAt,
      holder: input.serviceRunId,
      originStage: "kind" in input.issue ? "running" : "In Progress",
      reason: "plan_review",
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
    preflight,
    prompt,
    route,
  };
}

function assertReviewTarget(
  issue: Issue | Extract<SystemJob, { kind: "repair" }>,
  plan: Plan,
): void {
  const workRef = workReference(issue);
  if (
    ("kind" in issue ? issue.status !== "running" : issue.state !== "In Progress") ||
    plan.status !== "validated" ||
    plan.validated_at === null ||
    (workRef.kind === "issue"
      ? !("issue_id" in plan.work_ref) || plan.work_ref.issue_id !== issue.id
      : !("system_job_id" in plan.work_ref) || plan.work_ref.system_job_id !== issue.id)
  ) {
    throw new Error("plan_review.target_invalid");
  }
}

function renderPlanReviewPrompt(
  issue: Issue | Extract<SystemJob, { kind: "repair" }>,
  plan: Plan,
): string {
  return [
    "You are the independent Plan reviewer for a high-risk issue.",
    "Evaluate only the issue, acceptance criteria, validated Plan, and repository evidence.",
    "Report exactly one typed PlanReviewResult with evidence.",
    "",
    `Issue: ${JSON.stringify(issue)}`,
    `Validated Plan: ${JSON.stringify(plan)}`,
  ].join("\n");
}

function workReference(work: Issue | Extract<SystemJob, { kind: "repair" }>) {
  return "kind" in work
    ? { id: work.id, kind: "system_job" as const }
    : { id: work.id, kind: "issue" as const };
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
  if (!price) throw new Error(`plan_review.price_missing:${model}`);
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
    throw new Error("plan_review.preflight_manifest_mismatch");
  }
}

function requireIds(ids: readonly string[]): void {
  if (ids.some((id) => !id)) throw new Error("plan_review.identity_invalid");
}
