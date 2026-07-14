import {
  type AgentAdapter,
  type AgentPreflightResult,
  issueWorkspacePath,
  resolveRequiredSkills,
} from "@symphony/adapters";
import type {
  AgentAdapterManifest,
  Handoff,
  Issue,
  Plan,
  PlanReviewResult,
  SystemJob,
} from "@symphony/contracts";
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
  type ImplementationRetryReason,
  listAttemptUsageHistory,
  nextAttemptNumber,
  type OpenedDatabase,
  prepareDispatchBudget,
} from "@symphony/persistence";

export type ImplementationContinuationMode =
  | "approved_plan"
  | "plan_revision"
  | "review_rework"
  | "implementation_retry";

export type ImplementationContinuationSource =
  | { kind: "review"; result: PlanReviewResult }
  | {
      findings: readonly unknown[];
      handoff: Handoff;
      kind: "retry";
      reason: ImplementationRetryReason;
      routingFacts: readonly string[];
      summary: string;
    };

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
  expectedReadyReason:
    | ImplementationRetryReason
    | "implementation_after_plan_approval"
    | "plan_revision_required"
    | "review_rework";
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planImplementationContinuation(input: {
  adapter: AgentAdapter;
  changeClass: "standard" | "high_risk";
  configSnapshotId: string;
  configuration: ImplementationContinuationConfiguration;
  database: OpenedDatabase["database"];
  issue: Issue | Extract<SystemJob, { kind: "repair" }>;
  mode: ImplementationContinuationMode;
  newId(): string;
  now(): string;
  plan: Plan | null;
  source: ImplementationContinuationSource;
  serviceRunId: string;
  submitPlanSchema: Readonly<Record<string, unknown>>;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedImplementationContinuation> {
  assertSource(input.issue, input.plan, input.source, input.mode);
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
    changeClass: input.changeClass,
    enabledProfiles: input.configuration.enabledProfiles,
    facts: new Set(
      input.plan?.risk_facts ?? (input.source.kind === "retry" ? input.source.routingFacts : []),
    ),
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "implementation",
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
    limits: input.configuration.budgetLimits,
    ...(workRef.kind === "issue" ? { issueId: workRef.id } : { systemJobId: workRef.id }),
    updatedAt: now,
  });
  const prompt = renderPrompt(input);
  const expectedReadyReason = expectedReason(input.mode, input.source);
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber,
      changeClass: input.changeClass,
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
      workspacePath:
        "kind" in input.issue
          ? input.issue.workspace_path
          : issueWorkspacePath(input.configuration.workspaceRoot, input.issue.identifier),
    },
    claim: {
      acquiredAt: now,
      expiresAt: leaseExpiresAt,
      holder: input.serviceRunId,
      originStage: "kind" in input.issue ? input.issue.status : "In Progress",
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
  issue: Issue | Extract<SystemJob, { kind: "repair" }>,
  plan: Plan | null,
  source: ImplementationContinuationSource,
  mode: ImplementationContinuationMode,
): void {
  if (mode === "implementation_retry") {
    if (!isActive(issue) || source.kind !== "retry") {
      throw new Error("implementation_continuation.source_invalid");
    }
    if (plan && !planMatchesWork(plan, issue)) {
      throw new Error("implementation_continuation.source_invalid");
    }
    return;
  }
  if (!plan || source.kind !== "review") {
    throw new Error("implementation_continuation.source_invalid");
  }
  const reviewResult = source.result;
  const workMatches = planMatchesWork(plan, issue);
  const reviewMatches = reviewResult.plan_revision === plan.revision;
  const modeMatches =
    mode === "approved_plan"
      ? plan.status === "approved" &&
        plan.approved_by_attempt_id !== null &&
        reviewResult.decision === "approve"
      : mode === "plan_revision"
        ? plan.status === "rejected" && reviewResult.decision === "needs_rework"
        : (plan.status === "validated" || plan.status === "approved") &&
          reviewResult.decision === "needs_rework";
  if (!isActive(issue) || !workMatches || !reviewMatches || !modeMatches) {
    throw new Error("implementation_continuation.source_invalid");
  }
}

function isActive(work: Issue | Extract<SystemJob, { kind: "repair" }>): boolean {
  return "kind" in work
    ? work.status === "running" || work.status === "rework"
    : work.state === "In Progress";
}

function planMatchesWork(
  plan: Plan,
  work: Issue | Extract<SystemJob, { kind: "repair" }>,
): boolean {
  return "kind" in work
    ? "system_job_id" in plan.work_ref && plan.work_ref.system_job_id === work.id
    : "issue_id" in plan.work_ref && plan.work_ref.issue_id === work.id;
}

function workReference(work: Issue | Extract<SystemJob, { kind: "repair" }>) {
  return "kind" in work
    ? { id: work.id, kind: "system_job" as const }
    : { id: work.id, kind: "issue" as const };
}

function renderPrompt(input: {
  configuration: Pick<ImplementationContinuationConfiguration, "attemptTokenCap" | "maxTurns">;
  mode: ImplementationContinuationMode;
  plan: Plan | null;
  source: ImplementationContinuationSource;
}): string {
  const findings =
    input.source.kind === "review" ? input.source.result.findings : input.source.findings;
  const handoff =
    input.source.kind === "review" ? input.source.result.handoff : input.source.handoff;
  const currentPlanState =
    input.mode === "plan_revision" ||
    (input.mode === "implementation_retry" && input.plan?.status === "rejected")
      ? { revision: input.plan?.revision, status: input.plan?.status }
      : (input.plan ?? { status: "not_submitted" });
  return [
    "Continue implementation from durable orchestrator state in this existing workspace.",
    `Current Plan state: ${JSON.stringify(currentPlanState)}`,
    `Review findings: ${JSON.stringify(findings)}`,
    `Factual handoff: ${JSON.stringify(handoff)}`,
    `Last verification output: ${JSON.stringify(handoff.commands)}`,
    `Unmet acceptance criteria: ${JSON.stringify(handoff.open_items)}`,
    `Remaining turn budget: ${input.configuration.maxTurns}`,
    `Remaining token budget: ${input.configuration.attemptTokenCap}`,
    "You must submit a Plan revision before further action when planned paths, verification, size, or risks change.",
    modeInstruction(input.mode, input.source),
  ].join("\n");
}

function expectedReason(
  mode: ImplementationContinuationMode,
  source: ImplementationContinuationSource,
): PlannedImplementationContinuation["expectedReadyReason"] {
  if (mode === "approved_plan") return "implementation_after_plan_approval";
  if (mode === "plan_revision") return "plan_revision_required";
  if (mode === "implementation_retry" && source.kind === "retry") return source.reason;
  return "review_rework";
}

function modeInstruction(
  mode: ImplementationContinuationMode,
  source: ImplementationContinuationSource,
): string {
  if (mode === "plan_revision") {
    return "First submit a revised Plan that resolves every blocking review finding; do not change code before it is accepted.";
  }
  if (mode === "review_rework") {
    return "Resolve every blocking review finding, re-run verification, and report a typed implementation outcome.";
  }
  if (mode === "implementation_retry" && source.kind === "retry") {
    return `Resume from the factual handoff after ${source.reason}: ${source.summary}`;
  }
  return "Implement the approved Plan and report a typed implementation outcome.";
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
