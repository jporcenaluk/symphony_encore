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

export interface IntegrativeReviewContext {
  baseSha: string;
  changeClass: "standard" | "high_risk";
  changedFiles: readonly string[];
  diff: string;
  patchIdentity: string;
  repositoryDocs: readonly { content: string; path: string }[];
  targetSha: string;
  verificationRecordId: string;
}

export interface IntegrativeReviewAttemptConfiguration {
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

export interface PlannedIntegrativeReviewAttempt {
  attemptId: string;
  attemptNumber: number;
  context: IntegrativeReviewContext;
  dispatch: DispatchInput;
  estimatedTokens: number;
  estimatedUsd: number | null;
  preflight: AgentPreflightResult;
  prompt: string;
  route: ComputeRoute;
}

export async function planIntegrativeReviewAttempt(input: {
  adapter: AgentAdapter;
  configSnapshotId: string;
  configuration: IntegrativeReviewAttemptConfiguration;
  context: IntegrativeReviewContext;
  database: OpenedDatabase["database"];
  issue: Issue;
  newId(): string;
  now(): string;
  serviceRunId: string;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}): Promise<PlannedIntegrativeReviewAttempt> {
  assertTarget(input.issue, input.context);
  const manifest = await input.adapter.manifest();
  const requiredSkills = await resolveRequiredSkills({
    names: input.configuration.requiredSkills,
    roots: input.configuration.skillRoots,
  });
  const preflight = await input.adapter.preflight({
    requiredCapabilities: ["terminal_result", "skills"],
    requiredSkills,
    role: "integrative_review",
    terminalResultSchema: input.terminalResultSchema,
  });
  assertPreflightManifest(preflight, manifest);
  const route = selectComputeRoute({
    changeClass: input.context.changeClass,
    enabledProfiles: input.configuration.enabledProfiles,
    facts: new Set(),
    heuristicMinimum: null,
    resolvedProfiles: resolvedProfiles(manifest),
    riskFloorRules: input.configuration.riskFloorRules,
    role: "integrative_review",
    routeProfiles: input.configuration.routeProfiles,
  });
  const attemptId = requiredId(input.newId());
  const reservationId = requiredId(input.newId());
  const workRef = { id: input.issue.id, kind: "issue" as const };
  const attemptNumber = await nextAttemptNumber(input.database, workRef);
  const history = await listAttemptUsageHistory(input.database, {
    limit: input.configuration.historyWindowSamples,
    profile: route.profile,
    role: "integrative_review",
  });
  const configuredTokens = input.configuration.estimateTokensByProfile[route.profile];
  const estimatedTokens = estimateUsage({
    configuredEstimate: configuredTokens,
    history: history.map((entry) => entry.totalTokens),
    historyMinSamples: input.configuration.historyMinSamples,
    historyWindowSamples: input.configuration.historyWindowSamples,
  });
  const configuredUsd = configuredCost(manifest, route.model, configuredTokens);
  const estimatedUsd =
    configuredUsd === null
      ? null
      : estimateUsage({
          configuredEstimate: configuredUsd,
          history: history.flatMap((entry) => (entry.costUsd === null ? [] : [entry.costUsd])),
          historyMinSamples: input.configuration.historyMinSamples,
          historyWindowSamples: input.configuration.historyWindowSamples,
        });
  const now = input.now();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("review.timestamp_invalid");
  const ledgers = await prepareDispatchBudget(input.database, {
    attemptId,
    estimatedTokens,
    estimatedUsd,
    issueId: input.issue.id,
    limits: input.configuration.budgetLimits,
    updatedAt: now,
  });
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber,
      changeClass: input.context.changeClass,
      computeProfile: route.profile,
      configSnapshotId: input.configSnapshotId,
      costUsd: null,
      id: attemptId,
      model: route.model,
      priceTableVersion: manifest.price_table?.version ?? null,
      reasoningEffort: route.reasoningEffort,
      role: "integrative_review",
      routingReasons: route.reasons,
      startedAt: now,
      workspacePath: issueWorkspacePath(input.configuration.workspaceRoot, input.issue.identifier),
    },
    claim: {
      acquiredAt: now,
      expiresAt: new Date(nowMs + input.configuration.leaseTtlMs).toISOString(),
      holder: input.serviceRunId,
      originStage: "In Progress",
      reason: "integrative_review",
    },
    reservation: {
      id: reservationId,
      ledgers: ledgers.map((ledger) => ({ ...ledger })),
    },
    workRef,
  };
  return {
    attemptId,
    attemptNumber,
    context: input.context,
    dispatch,
    estimatedTokens,
    estimatedUsd,
    preflight,
    prompt: renderPrompt(input.issue, input.context),
    route,
  };
}

function renderPrompt(issue: Issue, context: IntegrativeReviewContext): string {
  return [
    "You are the fresh-context integrative reviewer for an immutable implementation.",
    "Review the full diff against the issue acceptance criteria and repository rules.",
    "Do not rely on builder narrative, self-review, or claims of correctness.",
    "Report exactly one typed ReviewResult targeting the supplied target SHA.",
    "Blocking findings require affected behavior, evidence, severity, and disposition.",
    "Unsupported stylistic preferences are non-blocking.",
    "",
    `Issue: ${JSON.stringify(issue)}`,
    `Review target: ${JSON.stringify({
      base_sha: context.baseSha,
      changed_files: context.changedFiles,
      patch_identity: context.patchIdentity,
      target_sha: context.targetSha,
      verification_record_id: context.verificationRecordId,
    })}`,
    `Repository docs: ${JSON.stringify(context.repositoryDocs)}`,
    `Full diff:\n${context.diff}`,
  ].join("\n");
}

function assertTarget(issue: Issue, context: IntegrativeReviewContext): void {
  if (
    !issue.id ||
    !/^[A-Fa-f0-9]{7,64}$/u.test(context.baseSha) ||
    !/^[A-Fa-f0-9]{7,64}$/u.test(context.targetSha) ||
    !context.patchIdentity ||
    !context.verificationRecordId
  ) {
    throw new Error("review.target_invalid");
  }
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
  tokens: number,
): number | null {
  if (manifest.price_table === null) return null;
  const price = manifest.price_table.models[model];
  if (!price) throw new Error(`review.price_missing:${model}`);
  return (tokens * Math.max(price.input_per_million_usd, price.output_per_million_usd)) / 1_000_000;
}

function assertPreflightManifest(
  preflight: AgentPreflightResult,
  manifest: AgentAdapterManifest,
): void {
  if (
    preflight.adapterVersion !== manifest.adapter_version ||
    preflight.protocolSchemaHash !== manifest.protocol.schema_hash
  ) {
    throw new Error("review.preflight_manifest_mismatch");
  }
}

function requiredId(id: string): string {
  if (!id) throw new Error("review.identity_invalid");
  return id;
}
