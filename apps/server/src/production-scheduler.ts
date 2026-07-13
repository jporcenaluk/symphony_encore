import { randomUUID } from "node:crypto";
import {
  type AgentAdapter,
  createCodexAppServerAdapter,
  createGhCliApiClient,
  createGitHubProjectsTransport,
  createGitHubTrackerAdapter,
  createGitHubWorkspaceRepositoryAdapter,
  createNodeGhCommandRunner,
  createNodeWorkspaceCommandRunner,
  discoverCodexAppServerManifest,
  type TrackerAdapter,
  terminateLinuxProcessGroup,
  type WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import {
  ImplementationOutcomeSchema,
  type Issue,
  PlanReviewResultSchema,
  PlanSchema,
  ReviewResultSchema,
} from "@symphony/contracts";
import type { ComputeProfile, ProvisionalClassification } from "@symphony/domain";
import {
  evaluateIssueEligibility,
  PersistenceSafetyController,
  parseComputeRoutingPolicy,
  SchedulerService,
  sortIssueCandidates,
} from "@symphony/orchestration";
import {
  type ConfigurationSnapshot,
  commitOrdinaryReviewSet,
  countRunningClaims,
  isWorkClaimed,
  loadClaimRecoveryState,
  loadIssue,
  loadLatestPlanByStatus,
  loadLatestPlanReviewResult,
  loadLatestValidatedPlan,
  loadPendingIndependentVerification,
  loadPendingIntegrativeReview,
  loadPendingReviewCoordination,
  type OpenedDatabase,
  observeIssue,
} from "@symphony/persistence";

import { syncTrackerCandidates } from "./candidate-sync.js";
import { startPlannedImplementationContinuationLifecycle } from "./implementation-continuation-lifecycle.js";
import { planImplementationContinuation } from "./implementation-continuation-planner.js";
import {
  type RevisionReader,
  runPendingIndependentVerification,
  type VerificationExecutor,
} from "./independent-verification-runner.js";
import { startPlannedInitialIssueAttemptLifecycle } from "./initial-issue-attempt-lifecycle.js";
import { planInitialIssueAttempt } from "./initial-issue-attempt-planner.js";
import { createInitialPlanSubmissionHandler } from "./initial-plan-submission.js";
import { startPlannedIntegrativeReviewAttemptLifecycle } from "./integrative-review-attempt-lifecycle.js";
import { planIntegrativeReviewAttempt } from "./integrative-review-attempt-planner.js";
import { collectIntegrativeReviewContext } from "./integrative-review-evidence.js";
import { startPlannedPlanReviewAttemptLifecycle } from "./plan-review-attempt-lifecycle.js";
import { planHighRiskPlanReviewAttempt } from "./plan-review-attempt-planner.js";
import {
  createPersistentRunningIssueReconciler,
  type RunningIssueRecord,
} from "./running-issue-reconciler.js";

interface SchedulerLogger {
  error(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export function createProductionScheduler(input: {
  agent?: AgentAdapter;
  database: OpenedDatabase["database"];
  environment: Readonly<Record<string, string | undefined>>;
  logger?: SchedulerLogger;
  prompt: string;
  repositoryAdapter?: WorkspaceRepositoryAdapter;
  serviceRunId: string;
  snapshot: ConfigurationSnapshot;
  tracker?: TrackerAdapter;
  review?: { collectEvidence?: typeof collectIntegrativeReviewContext };
  verification?: { execute?: VerificationExecutor; readRevision?: RevisionReader };
}) {
  const values = input.snapshot.effectiveConfig;
  const tracker =
    input.tracker ??
    createGitHubTrackerAdapter(
      createGitHubProjectsTransport(
        createGhCliApiClient({
          environment: input.environment,
          runner: createNodeGhCommandRunner(),
          timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
        }),
        {
          owner: stringValue(values, "tracker.owner"),
          priorityField: stringValue(values, "tracker.priority_field"),
          priorityOrder: stringList(values, "tracker.priority_order"),
          projectNumber: numberValue(values, "tracker.project_number"),
          repositoryName: stringValue(values, "tracker.repo_name"),
          repositoryOwner: stringValue(values, "tracker.repo_owner"),
          statusField: stringValue(values, "tracker.status_field"),
        },
      ),
      { acceptanceCriteriaHeading: stringValue(values, "tracker.acceptance_criteria_heading") },
    );
  const running = new Map<string, RunningIssueRecord>();
  const completions = new Set<Promise<void>>();
  const safety = new PersistenceSafetyController(async (failure) => {
    let stopError: unknown;
    for (const record of running.values()) {
      try {
        await terminateLinuxProcessGroup({
          killWaitMs: 5_000,
          processGroupId: record.processGroupId,
          processId: record.processId,
          terminateWaitMs: 1_000,
        });
      } catch (error) {
        stopError ??= error;
      }
    }
    input.logger?.error({ failure, stop_error: stopError }, "persistence safety latch activated");
    if (stopError) throw stopError;
  });
  const reconcile = createPersistentRunningIssueReconciler({
    allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
    beforeRemoveCommand: nullableString(values, "hooks.before_remove"),
    config: {
      configuredAssignee: nullableString(values, "tracker.assignee"),
      leaseTtlMs: numberValue(values, "persistence.lease_ttl_ms"),
      requiredLabels: stringList(values, "tracker.required_labels"),
      retryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
      stallTimeoutMs: numberValue(values, "agent.stall_timeout_ms"),
    },
    database: input.database,
    hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
    killWaitMs: 5_000,
    newId: randomUUID,
    now: () => new Date().toISOString(),
    onBeforeRemoveResult(result) {
      if (result.status !== "passed") {
        input.logger?.warn({ hook: "before_remove", result }, "workspace hook failed");
      }
    },
    onRunningLoaded(records) {
      running.clear();
      for (const record of records) running.set(record.attemptId, record);
    },
    safety,
    sourceEnvironment: input.environment,
    terminateWaitMs: 1_000,
    tracker,
    workspaceRoot: stringValue(values, "workspace.root"),
  });
  const agent = input.agent ?? createLazyProductionAgent(values, input.environment);
  const repositoryAdapter =
    input.repositoryAdapter ?? createLazyGitHubWorkspaceAdapter(values, input.environment);
  const service = new SchedulerService({
    intervalMs: numberValue(values, "polling.interval_ms"),
    onError(error) {
      input.logger?.error(
        { error, service_run_id: input.serviceRunId },
        "scheduler reconciliation tick failed",
      );
    },
    async tick() {
      await reconcile();
      if (!safety.canDispatch()) return;
      let availableSlots = Math.max(
        0,
        numberValue(values, "agent.max_concurrent") - (await countRunningClaims(input.database)),
      );
      const recoveryState = await loadClaimRecoveryState(input.database, new Date().toISOString());
      for (const claim of recoveryState.ready) {
        if (!safety.canDispatch()) break;
        const isReviewCoordination = claim.reason === "review_coordination_required";
        if (availableSlots < 1 && !isReviewCoordination) continue;
        const isPlanReview = claim.reason === "plan_review_required";
        const isIndependentVerification = claim.reason === "independent_verification_required";
        const isIntegrativeReview = claim.reason === "review_required";
        const isImplementationContinuation =
          claim.reason === "implementation_after_plan_approval" ||
          claim.reason === "plan_revision_required";
        if (
          (!isPlanReview &&
            !isIndependentVerification &&
            !isIntegrativeReview &&
            !isReviewCoordination &&
            !isImplementationContinuation) ||
          !("issue_id" in claim.work_ref)
        ) {
          continue;
        }
        const issueId = claim.work_ref.issue_id;
        try {
          const stored = await loadIssue(input.database, issueId);
          if (!stored) throw new Error(`scheduler.ready_issue_missing:${issueId}`);
          if (isReviewCoordination) {
            const pending = await loadPendingReviewCoordination(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!pending) throw new Error(`scheduler.review_coordination_missing:${issueId}`);
            if (pending.changeClass === "high_risk") {
              throw new Error(`scheduler.specialist_coordination_pending:${issueId}`);
            }
            await commitOrdinaryReviewSet(input.database, {
              createdAt: new Date().toISOString(),
              id: randomUUID(),
              requiredSpecialistNames: [],
              workRef: { id: issueId, kind: "issue" },
            });
            continue;
          }
          if (isIndependentVerification) {
            const target = await loadPendingIndependentVerification(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.verification_target_missing:${issueId}`);
            await runPendingIndependentVerification({
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              command: stringValue(values, "workspace.verify_command"),
              database: input.database,
              ...(input.verification?.execute ? { execute: input.verification.execute } : {}),
              newId: randomUUID,
              ...(input.verification?.readRevision
                ? { readRevision: input.verification.readRevision }
                : {}),
              safety,
              sourceEnvironment: input.environment,
              target,
              timeoutMs: numberValue(values, "hooks.timeout_ms"),
              verifyNoneReason: nullableString(values, "workspace.verify_none_reason"),
              workRef: { id: issueId, kind: "issue" },
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            continue;
          }
          if (isIntegrativeReview) {
            const target = await loadPendingIntegrativeReview(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.review_target_missing:${issueId}`);
            const context = await (
              input.review?.collectEvidence ?? collectIntegrativeReviewContext
            )({
              baseSha: target.baseSha,
              changeClass: target.changeClass,
              commandRunner: createNodeWorkspaceCommandRunner(),
              sourceEnvironment: input.environment,
              targetSha: target.targetSha,
              timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
              verificationRecordId: target.verificationRecordId,
              workspace: target.workspacePath,
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            const reviewPlanned = await planIntegrativeReviewAttempt({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              context,
              database: input.database,
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              serviceRunId: input.serviceRunId,
              terminalResultSchema: ReviewResultSchema,
            });
            const reviewStarted = await startPlannedIntegrativeReviewAttemptLifecycle({
              adapter: agent,
              agentCommand: stringValue(values, "agent.command"),
              afterCreateCommand: nullableString(values, "hooks.after_create"),
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
              beforeRunCommand: nullableString(values, "hooks.before_run"),
              database: input.database,
              hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              planned: reviewPlanned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            availableSlots -= 1;
            running.set(reviewPlanned.attemptId, {
              attemptId: reviewPlanned.attemptId,
              attemptLane: "In Progress",
              expectedExpiresAt: reviewPlanned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId,
              lastEventAt: reviewStarted.bound.started.timestamp,
              processGroupId: reviewStarted.bound.session.processGroupId,
              processId: reviewStarted.bound.session.processId,
              workspacePath: reviewPlanned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              reviewStarted.completion,
              () => running.delete(reviewPlanned.attemptId),
              (error) =>
                input.logger?.error(
                  { attempt_id: reviewPlanned.attemptId, error },
                  "integrative review lifecycle failed",
                ),
            );
            continue;
          }
          let planned:
            | Awaited<ReturnType<typeof planHighRiskPlanReviewAttempt>>
            | Awaited<ReturnType<typeof planImplementationContinuation>>;
          let started:
            | Awaited<ReturnType<typeof startPlannedPlanReviewAttemptLifecycle>>
            | Awaited<ReturnType<typeof startPlannedImplementationContinuationLifecycle>>;
          if (isPlanReview) {
            const plan = await loadLatestValidatedPlan(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!plan) throw new Error(`scheduler.ready_plan_missing:${issueId}`);
            planned = await planHighRiskPlanReviewAttempt({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              database: input.database,
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              plan,
              serviceRunId: input.serviceRunId,
              terminalResultSchema: PlanReviewResultSchema,
            });
            started = await startPlannedPlanReviewAttemptLifecycle({
              adapter: agent,
              agentCommand: stringValue(values, "agent.command"),
              afterCreateCommand: nullableString(values, "hooks.after_create"),
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
              beforeRunCommand: nullableString(values, "hooks.before_run"),
              database: input.database,
              hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
              issue: stored.issue,
              maxPlanRevisions: numberValue(values, "agent.max_plan_revisions"),
              newId: randomUUID,
              now: () => new Date().toISOString(),
              plan,
              planned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
          } else {
            const mode =
              claim.reason === "implementation_after_plan_approval"
                ? ("approved_plan" as const)
                : ("plan_revision" as const);
            const plan = await loadLatestPlanByStatus(
              input.database,
              { id: issueId, kind: "issue" },
              mode === "approved_plan" ? "approved" : "rejected",
            );
            const review = await loadLatestPlanReviewResult(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!plan || !review) {
              throw new Error(`scheduler.ready_implementation_handoff_missing:${issueId}`);
            }
            const implementationPlanned = await planImplementationContinuation({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              database: input.database,
              issue: stored.issue,
              mode,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              plan,
              reviewResult: review.result,
              serviceRunId: input.serviceRunId,
              submitPlanSchema: PlanSchema,
              terminalResultSchema: ImplementationOutcomeSchema,
            });
            started = await startPlannedImplementationContinuationLifecycle({
              adapter: agent,
              agentCommand: stringValue(values, "agent.command"),
              afterCreateCommand: nullableString(values, "hooks.after_create"),
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
              beforeRunCommand: nullableString(values, "hooks.before_run"),
              database: input.database,
              hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              onPlanSubmitted: createInitialPlanSubmissionHandler({
                attemptId: implementationPlanned.attemptId,
                database: input.database,
                issue: stored.issue,
                now: () => new Date().toISOString(),
                provisionalClassification: {
                  changeClass: "high_risk",
                  floor: "high_risk",
                  reasons: ["classification.reviewed_high_risk_plan"],
                },
                riskPathPatterns: stringList(values, "class.risk_paths"),
                safety,
                trivialMaxChangedLines: numberValue(values, "class.trivial_max_changed_lines"),
                trivialPathPatterns: stringList(values, "class.trivial_patterns"),
                workspacePath: implementationPlanned.dispatch.attempt.workspacePath,
              }),
              planned: implementationPlanned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            planned = implementationPlanned;
          }
          availableSlots -= 1;
          running.set(planned.attemptId, {
            attemptId: planned.attemptId,
            attemptLane: "In Progress",
            expectedExpiresAt: planned.dispatch.claim.expiresAt,
            holder: input.serviceRunId,
            issueId,
            lastEventAt: started.bound.started.timestamp,
            processGroupId: started.bound.session.processGroupId,
            processId: started.bound.session.processId,
            workspacePath: planned.dispatch.attempt.workspacePath,
          });
          trackCompletion(
            completions,
            started.completion,
            () => running.delete(planned.attemptId),
            (error) =>
              input.logger?.error(
                { attempt_id: planned.attemptId, error },
                "Ready continuation attempt lifecycle failed",
              ),
          );
        } catch (error) {
          input.logger?.warn(
            { error, issue_id: issueId },
            "Ready continuation dispatch skipped scheduler tick",
          );
          if (!safety.canDispatch()) throw error;
        }
      }
      let candidates: Issue[];
      try {
        candidates = await syncTrackerCandidates({
          observeIssue: (issue, providerRevision) =>
            observeIssue(input.database, {
              issue,
              observedAt: new Date().toISOString(),
              providerRevision,
              transitionId: randomUUID(),
            }),
          safety,
          tracker,
        });
      } catch (error) {
        if (!safety.canDispatch()) throw error;
        input.logger?.warn(
          { error, service_run_id: input.serviceRunId },
          "candidate fetch skipped scheduler tick",
        );
        return;
      }
      if (candidates.length === 0 || !safety.canDispatch()) return;
      for (const candidate of sortIssueCandidates(candidates)) {
        if (availableSlots < 1 || !safety.canDispatch()) break;
        const claimed = await isWorkClaimed(input.database, { id: candidate.id, kind: "issue" });
        const eligibility = evaluateIssueEligibility({
          availableSlots,
          configuredAssignee: nullableString(values, "tracker.assignee"),
          issue: candidate,
          preflightPassed: true,
          requiredLabels: stringList(values, "tracker.required_labels"),
          workClaimed: claimed,
        });
        if (!eligibility.eligible) continue;
        const stored = await loadIssue(input.database, candidate.id);
        if (!stored) throw new Error(`scheduler.candidate_not_observed:${candidate.id}`);
        try {
          const planned = await planInitialIssueAttempt({
            adapter: agent,
            configSnapshotId: input.snapshot.id,
            configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
            database: input.database,
            issue: stored.issue,
            newId: randomUUID,
            now: () => new Date().toISOString(),
            providerRevision: stored.providerRevision,
            routingFacts: issueRoutingFacts(stored.issue),
            serviceRunId: input.serviceRunId,
            submitPlanSchema: PlanSchema,
            terminalResultSchema: ImplementationOutcomeSchema,
          });
          const started = await startPlannedInitialIssueAttemptLifecycle({
            adapter: agent,
            agentCommand: stringValue(values, "agent.command"),
            afterCreateCommand: nullableString(values, "hooks.after_create"),
            allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
            attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
            beforeRunCommand: nullableString(values, "hooks.before_run"),
            database: input.database,
            hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
            issue: stored.issue,
            newId: randomUUID,
            now: () => new Date().toISOString(),
            onPlanSubmitted: createInitialPlanSubmissionHandler({
              attemptId: planned.attemptId,
              database: input.database,
              issue: stored.issue,
              now: () => new Date().toISOString(),
              provisionalClassification: plannedProvisionalClassification(planned),
              riskPathPatterns: stringList(values, "class.risk_paths"),
              safety,
              trivialMaxChangedLines: numberValue(values, "class.trivial_max_changed_lines"),
              trivialPathPatterns: stringList(values, "class.trivial_patterns"),
              workspacePath: planned.record.dispatch.attempt.workspacePath,
            }),
            planned,
            repositoryAdapter,
            safety,
            serviceRunId: input.serviceRunId,
            sourceEnvironment: input.environment,
            tracker,
            usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
            workspaceRoot: stringValue(values, "workspace.root"),
          });
          availableSlots -= 1;
          running.set(planned.attemptId, {
            attemptId: planned.attemptId,
            attemptLane: "In Progress",
            expectedExpiresAt: planned.record.dispatch.claim.expiresAt,
            holder: input.serviceRunId,
            issueId: stored.issue.id,
            lastEventAt: started.bound.started.timestamp,
            processGroupId: started.bound.session.processGroupId,
            processId: started.bound.session.processId,
            workspacePath: planned.record.dispatch.attempt.workspacePath,
          });
          trackCompletion(
            completions,
            started.completion,
            () => running.delete(planned.attemptId),
            (error) =>
              input.logger?.error(
                { attempt_id: planned.attemptId, error },
                "issue attempt lifecycle failed",
              ),
          );
        } catch (error) {
          input.logger?.warn(
            { error, issue_id: candidate.id },
            "candidate dispatch skipped scheduler tick",
          );
          if (!safety.canDispatch()) throw error;
        }
      }
    },
  });
  return {
    close: async () => {
      await service.close();
      for (const record of running.values()) {
        await terminateLinuxProcessGroup({
          killWaitMs: 5_000,
          processGroupId: record.processGroupId,
          processId: record.processId,
          terminateWaitMs: 1_000,
        }).catch(() => undefined);
      }
      await Promise.allSettled([...completions]);
    },
    start: () => service.start(),
    trigger: () => service.trigger(),
  };
}

function stringValue(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`scheduler.config:${key}`);
  return value;
}

function nullableString(values: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = values[key];
  if (value === null) return null;
  return stringValue(values, key);
}

function numberValue(values: Readonly<Record<string, unknown>>, key: string): number {
  const value = values[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`scheduler.config:${key}`);
  }
  return value;
}

function stringList(values: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = values[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`scheduler.config:${key}`);
  }
  return value as string[];
}

function initialAttemptConfiguration(
  values: Readonly<Record<string, unknown>>,
  prompt: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const routing = parseComputeRoutingPolicy({
    riskFloorRules: values["compute.risk_floor_rules"],
    routeProfiles: values["compute.route_profiles"],
  });
  const estimates = profileMap(values, "budget.estimate_tokens_by_profile");
  const home = environment.HOME;
  return {
    attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
    budgetLimits: {
      attemptTokens: numberValue(values, "budget.per_attempt_tokens"),
      attemptUsd: positiveNumberValue(values, "budget.per_attempt_usd"),
      fleetTokens: numberValue(values, "budget.rolling_24h_tokens"),
      fleetUsd: positiveNumberValue(values, "budget.rolling_24h_usd"),
      issueTokens: numberValue(values, "budget.per_issue_tokens"),
      issueUsd: positiveNumberValue(values, "budget.per_issue_usd"),
    },
    enabledProfiles: computeProfiles(values, "compute.enabled_profiles"),
    estimateTokensByProfile: estimates,
    historyMinSamples: numberValue(values, "budget.history_min_samples"),
    historyWindowSamples: numberValue(values, "budget.history_window_samples"),
    leaseTtlMs: numberValue(values, "persistence.lease_ttl_ms"),
    maxTurns: numberValue(values, "agent.max_turns"),
    prompt,
    requiredSkills: stringList(values, "agent.required_skills"),
    riskFloorRules: routing.riskFloorRules,
    routeProfiles: routing.routeProfiles,
    rules: rulesBlock(prompt),
    skillRoots: [
      pathFromRoot(process.cwd(), ".agents/skills"),
      pathFromRoot(process.cwd(), ".codex/skills"),
      ...(home ? [pathFromRoot(home, ".agents/skills"), pathFromRoot(home, ".codex/skills")] : []),
    ],
    workspaceRoot: stringValue(values, "workspace.root"),
  };
}

function plannedProvisionalClassification(
  planned: Awaited<ReturnType<typeof planInitialIssueAttempt>>,
): ProvisionalClassification {
  const attempt = planned.record.dispatch.attempt;
  const classificationReasons = attempt.routingReasons.filter(
    (reason) => !reason.startsWith("route."),
  );
  if (attempt.changeClass === "high_risk") {
    return { changeClass: "high_risk", floor: "high_risk", reasons: classificationReasons };
  }
  return {
    changeClass: "standard",
    floor: classificationReasons.includes("classification.unknown") ? null : "standard",
    reasons: classificationReasons,
  };
}

function computeProfiles(values: Readonly<Record<string, unknown>>, key: string): ComputeProfile[] {
  const profiles = stringList(values, key);
  if (
    profiles.some(
      (profile) => profile !== "economy" && profile !== "standard" && profile !== "deep",
    )
  ) {
    throw new Error(`scheduler.config:${key}`);
  }
  return profiles as ComputeProfile[];
}

function profileMap(
  values: Readonly<Record<string, unknown>>,
  key: string,
): Record<ComputeProfile, number> {
  const value = values[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`scheduler.config:${key}`);
  }
  const record = value as Record<string, unknown>;
  return {
    deep: requiredPositiveNumber(record.deep, key),
    economy: requiredPositiveNumber(record.economy, key),
    standard: requiredPositiveNumber(record.standard, key),
  };
}

function requiredPositiveNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`scheduler.config:${key}`);
  }
  return value;
}

function positiveNumberValue(values: Readonly<Record<string, unknown>>, key: string): number {
  return requiredPositiveNumber(values[key], key);
}

function issueRoutingFacts(issue: Issue): ReadonlySet<string> {
  const facts = new Set(issue.labels.map((label) => `label:${label}`));
  facts.add(
    issue.acceptance_criteria.length > 0
      ? "acceptance_criteria:present"
      : "acceptance_criteria:missing",
  );
  for (const blocker of issue.blocked_by) {
    facts.add(`dependency:${blocker.id}:${blocker.state}`);
  }
  const labels = new Set(issue.labels);
  if (labels.has("security") || labels.has("auth")) facts.add("risk.security_auth");
  if (labels.has("migration") || labels.has("data")) facts.add("risk.migration_data");
  if (labels.has("concurrency")) facts.add("risk.concurrency");
  if (labels.has("public-api")) facts.add("risk.public_api");
  if (labels.has("architecture")) facts.add("risk.cross_package_architecture");
  if (issue.acceptance_criteria.length === 0) facts.add("risk.ambiguous_criteria");
  return facts;
}

function rulesBlock(prompt: string): string {
  const match = /<!-- rules:start -->([\s\S]*?)<!-- rules:end -->/u.exec(prompt);
  return match?.[1]?.trim() ?? "";
}

function pathFromRoot(root: string, suffix: string): string {
  return `${root.replace(/\/+$/u, "")}/${suffix}`;
}

function createLazyProductionAgent(
  values: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): AgentAdapter {
  let resolved: Promise<AgentAdapter> | undefined;
  const load = () => {
    resolved ??= discoverCodexAppServerManifest({
      command: stringValue(values, "agent.command"),
      environment,
      readTimeoutMs: numberValue(values, "agent.read_timeout_ms"),
    }).then((manifest) =>
      createCodexAppServerAdapter({
        manifest,
        readTimeoutMs: numberValue(values, "agent.read_timeout_ms"),
        stallTimeoutMs: numberValue(values, "agent.stall_timeout_ms"),
        turnTimeoutMs: numberValue(values, "agent.turn_timeout_ms"),
      }),
    );
    return resolved;
  };
  return {
    launch: async (request) => (await load()).launch(request),
    manifest: async () => (await load()).manifest(),
    preflight: async (request) => (await load()).preflight(request),
  };
}

function createLazyGitHubWorkspaceAdapter(
  values: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): WorkspaceRepositoryAdapter {
  let resolved: WorkspaceRepositoryAdapter | undefined;
  const load = () => {
    resolved ??= createGitHubWorkspaceRepositoryAdapter({
      api: createGhCliApiClient({
        environment,
        runner: createNodeGhCommandRunner(),
        timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
      }),
      commandRunner: createNodeWorkspaceCommandRunner(),
      environment,
      timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
    });
    return resolved;
  };
  return {
    populateIssueWorkspace: (request) => load().populateIssueWorkspace(request),
  };
}

function trackCompletion(
  completions: Set<Promise<void>>,
  completion: Promise<unknown>,
  onFinally: () => void,
  onError: (error: unknown) => void,
): void {
  let tracked: Promise<void>;
  tracked = completion
    .then(() => undefined)
    .catch(onError)
    .finally(() => {
      onFinally();
      completions.delete(tracked);
    });
  completions.add(tracked);
}
