import { randomUUID } from "node:crypto";
import {
  type AgentAdapter,
  createCodexAppServerAdapter,
  createGhCliApiClient,
  createGitHubProjectsTransport,
  createGitHubRepositoryHostingAdapter,
  createGitHubRepositoryTransport,
  createGitHubTrackerAdapter,
  createGitHubWorkspaceRepositoryAdapter,
  createNodeGhCommandRunner,
  createNodeWorkspaceCommandRunner,
  discoverCodexAppServerManifest,
  type RepositoryHostingAdapter,
  readWorkspaceHeadRevision,
  syncWorkspaceToPublishedBranch,
  type TrackerAdapter,
  terminateLinuxProcessGroup,
  type WorkspaceRepositoryAdapter,
} from "@symphony/adapters";
import {
  AdjudicationResultSchema,
  ImplementationOutcomeSchema,
  type Issue,
  type Plan,
  type PlanReviewResult,
  PlanReviewResultSchema,
  PlanSchema,
  ReviewResultSchema,
  type SystemJob,
} from "@symphony/contracts";
import {
  type ComputeProfile,
  findContraryReviewFindings,
  type ProvisionalClassification,
} from "@symphony/domain";
import {
  evaluateIssueEligibility,
  PersistenceSafetyController,
  parseComputeRoutingPolicy,
  parseReviewSpecialists,
  SchedulerService,
  selectRequiredSpecialists,
  sortIssueCandidates,
} from "@symphony/orchestration";
import {
  type ConfigurationSnapshot,
  commitOrdinaryReviewSet,
  countRunningClaims,
  hasActiveRepositoryMerge,
  isImplementationRetryReason,
  isWorkClaimed,
  loadClaimRecoveryState,
  loadIssue,
  loadLatestPlanByStatus,
  loadLatestPlanReviewResult,
  loadLatestValidatedPlan,
  loadPendingBaseUpdate,
  loadPendingImplementationRetry,
  loadPendingIndependentVerification,
  loadPendingIntegrativeReview,
  loadPendingMergeQueue,
  loadPendingPostMerge,
  loadPendingPullRequestGate,
  loadPendingRepairPublication,
  loadPendingRepositoryPublication,
  loadPendingReviewCoordination,
  loadSystemJob,
  type OpenedDatabase,
  observeIssue,
  promoteDueRetryClaims,
  routeNextReviewSpecialist,
  routeReviewAdjudication,
} from "@symphony/persistence";

import { syncTrackerCandidates } from "./candidate-sync.js";
import { startPlannedImplementationContinuationLifecycle } from "./implementation-continuation-lifecycle.js";
import {
  type ImplementationContinuationSource,
  planImplementationContinuation,
} from "./implementation-continuation-planner.js";
import {
  type RevisionReader,
  runPendingIndependentVerification,
  type VerificationExecutor,
} from "./independent-verification-runner.js";
import { startPlannedInitialIssueAttemptLifecycle } from "./initial-issue-attempt-lifecycle.js";
import { planInitialIssueAttempt } from "./initial-issue-attempt-planner.js";
import { createInitialPlanSubmissionHandler } from "./initial-plan-submission.js";
import { startPlannedInitialSystemJobAttemptLifecycle } from "./initial-system-job-attempt-lifecycle.js";
import { planInitialSystemJobAttempt } from "./initial-system-job-attempt-planner.js";
import {
  startPlannedAdjudicationAttemptLifecycle,
  startPlannedIntegrativeReviewAttemptLifecycle,
  startPlannedSpecialistReviewAttemptLifecycle,
} from "./integrative-review-attempt-lifecycle.js";
import {
  planAdjudicationAttempt,
  planIntegrativeReviewAttempt,
  planSpecialistReviewAttempt,
} from "./integrative-review-attempt-planner.js";
import { collectIntegrativeReviewContext } from "./integrative-review-evidence.js";
import {
  executeBaseUpdate,
  executeMergeQueueLanding,
  executePostMergeVerification,
  executeRepairParentCompletion,
  executeSystemJobPostMergeVerification,
} from "./merge-queue.js";
import { startPlannedPlanReviewAttemptLifecycle } from "./plan-review-attempt-lifecycle.js";
import { planHighRiskPlanReviewAttempt } from "./plan-review-attempt-planner.js";
import { runPullRequestHygiene } from "./pull-request-hygiene.js";
import {
  executeRepairRepositoryPublication,
  executeRepositoryPublication,
} from "./repository-publication.js";
import {
  createPersistentRunningIssueReconciler,
  createPersistentRunningSystemJobReconciler,
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
  repositoryHostingAdapter?: RepositoryHostingAdapter;
  repositorySync?(request: {
    branch: string;
    expectedHeadSha: string;
    workspace: string;
  }): Promise<string>;
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
  const runningSystemJobAttempts = new Set<string>();
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
      for (const attemptId of running.keys()) {
        if (!runningSystemJobAttempts.has(attemptId)) running.delete(attemptId);
      }
      for (const record of records) running.set(record.attemptId, record);
    },
    safety,
    sourceEnvironment: input.environment,
    terminateWaitMs: 1_000,
    tracker,
    workspaceRoot: stringValue(values, "workspace.root"),
  });
  const reconcileSystemJobs = createPersistentRunningSystemJobReconciler({
    config: {
      leaseTtlMs: numberValue(values, "persistence.lease_ttl_ms"),
      retryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
      stallTimeoutMs: numberValue(values, "agent.stall_timeout_ms"),
    },
    database: input.database,
    killWaitMs: 5_000,
    newId: randomUUID,
    now: () => new Date().toISOString(),
    onRunningLoaded(records) {
      const loaded = new Set(records.map((record) => record.attemptId));
      for (const attemptId of runningSystemJobAttempts) {
        if (!loaded.has(attemptId)) {
          runningSystemJobAttempts.delete(attemptId);
          running.delete(attemptId);
        }
      }
      for (const record of records) {
        runningSystemJobAttempts.add(record.attemptId);
        running.set(record.attemptId, record);
      }
    },
    safety,
    terminateWaitMs: 1_000,
  });
  const agent = input.agent ?? createLazyProductionAgent(values, input.environment);
  const repositoryAdapter =
    input.repositoryAdapter ?? createLazyGitHubWorkspaceAdapter(values, input.environment);
  const repositoryName = `${stringValue(values, "tracker.repo_owner")}/${stringValue(
    values,
    "tracker.repo_name",
  )}`;
  const repositoryHostingAdapter =
    input.repositoryHostingAdapter ??
    createGitHubRepositoryHostingAdapter(
      createGitHubRepositoryTransport({
        api: createGhCliApiClient({
          environment: input.environment,
          runner: createNodeGhCommandRunner(),
          timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
        }),
        commandRunner: createNodeWorkspaceCommandRunner(),
        configuredRequiredChecks: stringList(values, "review.required_checks"),
        environment: input.environment,
        repository: repositoryName,
        timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
      }),
      { repository: repositoryName },
    );
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
      await reconcileSystemJobs();
      if (!safety.canDispatch()) return;
      let availableSlots = Math.max(
        0,
        numberValue(values, "agent.max_concurrent") - (await countRunningClaims(input.database)),
      );
      const recoveryNow = new Date().toISOString();
      await promoteDueRetryClaims(input.database, recoveryNow);
      const recoveryState = await loadClaimRecoveryState(input.database, recoveryNow);
      const repositoryMergeActive = await hasActiveRepositoryMerge(input.database, repositoryName);
      for (const claim of recoveryState.ready) {
        if (!safety.canDispatch()) break;
        const isReviewCoordination = claim.reason === "review_coordination_required";
        const isRepairParentCompletion =
          claim.reason === "repair_completed" || claim.reason === "repair_completion_done_required";
        const isSystemJobDispatch =
          claim.reason === "system_job_dispatch_required" && "system_job_id" in claim.work_ref;
        const isRepositoryPublication =
          claim.reason === "pull_request_required" && repositoryHostingAdapter !== undefined;
        const isPullRequestHygiene =
          claim.reason === "pull_request_hygiene_required" &&
          repositoryHostingAdapter !== undefined;
        const isMergeQueue =
          claim.reason === "merge_queue_required" && repositoryHostingAdapter !== undefined;
        const isPostMerge =
          claim.reason === "post_merge_verification_required" &&
          repositoryHostingAdapter !== undefined;
        const isBaseUpdate =
          claim.reason === "base_update_required" && repositoryHostingAdapter !== undefined;
        if (
          availableSlots < 1 &&
          !isReviewCoordination &&
          !isRepairParentCompletion &&
          !isRepositoryPublication &&
          !isPullRequestHygiene &&
          !isMergeQueue &&
          !isPostMerge &&
          !isBaseUpdate
        )
          continue;
        const isPlanReview = claim.reason === "plan_review_required";
        const isBaseUpdateVerification =
          claim.reason === "independent_verification_after_base_update_required";
        const isIndependentVerification =
          claim.reason === "independent_verification_required" || isBaseUpdateVerification;
        const isIntegrativeReview = claim.reason === "review_required";
        const isAdjudication = claim.reason === "adjudication_required";
        const isReviewRework = claim.reason === "review_rework";
        const isImplementationRetry = isImplementationRetryReason(claim.reason);
        const isSpecialistReview = claim.reason.startsWith("specialist_review_required:");
        const isImplementationContinuation =
          claim.reason === "implementation_after_plan_approval" ||
          claim.reason === "plan_revision_required" ||
          isReviewRework ||
          isImplementationRetry;
        if (
          !isPlanReview &&
          !isSystemJobDispatch &&
          !isIndependentVerification &&
          !isIntegrativeReview &&
          !isAdjudication &&
          !isReviewCoordination &&
          !isRepairParentCompletion &&
          !isRepositoryPublication &&
          !isPullRequestHygiene &&
          !isMergeQueue &&
          !isPostMerge &&
          !isBaseUpdate &&
          !isSpecialistReview &&
          !isImplementationContinuation
        ) {
          continue;
        }
        if (isSystemJobDispatch && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const planned = await planInitialSystemJobAttempt({
              adapter: agent,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              database: input.database,
              job,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              serviceRunId: input.serviceRunId,
              submitPlanSchema: PlanSchema,
              terminalResultSchema: ImplementationOutcomeSchema,
            });
            const started = await startPlannedInitialSystemJobAttemptLifecycle({
              adapter: agent,
              agentCommand: stringValue(values, "agent.command"),
              afterCreateCommand: nullableString(values, "hooks.after_create"),
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
              beforeRunCommand: nullableString(values, "hooks.before_run"),
              database: input.database,
              hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
              job,
              maxFailureRetries: numberValue(values, "agent.max_failure_retries"),
              maxRetryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
              maxReworkCycles: numberValue(values, "agent.max_rework_cycles"),
              newId: randomUUID,
              now: () => new Date().toISOString(),
              onPlanSubmitted: createInitialPlanSubmissionHandler({
                attemptId: planned.attemptId,
                database: input.database,
                issue: job,
                now: () => new Date().toISOString(),
                provisionalClassification: provisionalClassificationForAttempt(
                  planned.dispatch.attempt,
                ),
                riskPathPatterns: stringList(values, "class.risk_paths"),
                safety,
                trivialMaxChangedLines: numberValue(values, "class.trivial_max_changed_lines"),
                trivialPathPatterns: stringList(values, "class.trivial_patterns"),
                workspacePath: planned.dispatch.attempt.workspacePath,
              }),
              planned,
              repositoryAdapter,
              retryJitterSample: Math.random(),
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            availableSlots -= 1;
            runningSystemJobAttempts.add(planned.attemptId);
            running.set(planned.attemptId, {
              attemptId: planned.attemptId,
              attemptLane: "running",
              expectedExpiresAt: planned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId: systemJobId,
              lastEventAt: started.bound.started.timestamp,
              processGroupId: started.bound.session.processGroupId,
              processId: started.bound.session.processId,
              workspacePath: planned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              started.completion,
              () => {
                running.delete(planned.attemptId);
                runningSystemJobAttempts.delete(planned.attemptId);
              },
              (error) =>
                input.logger?.error(
                  { attempt_id: planned.attemptId, error, system_job_id: systemJobId },
                  "repair SystemJob attempt lifecycle failed",
                ),
            );
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob dispatch skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if ((isPlanReview || isImplementationContinuation) && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const workRef = { id: systemJobId, kind: "system_job" as const };
            let planned:
              | Awaited<ReturnType<typeof planHighRiskPlanReviewAttempt>>
              | Awaited<ReturnType<typeof planImplementationContinuation>>;
            let started:
              | Awaited<ReturnType<typeof startPlannedPlanReviewAttemptLifecycle>>
              | Awaited<ReturnType<typeof startPlannedImplementationContinuationLifecycle>>;
            if (isPlanReview) {
              const plan = await loadLatestValidatedPlan(input.database, workRef);
              if (!plan) throw new Error(`scheduler.ready_plan_missing:${systemJobId}`);
              planned = await planHighRiskPlanReviewAttempt({
                adapter: agent,
                configSnapshotId: input.snapshot.id,
                configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
                database: input.database,
                issue: job,
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
                issue: job,
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
                  : claim.reason === "plan_revision_required"
                    ? ("plan_revision" as const)
                    : isReviewRework
                      ? ("review_rework" as const)
                      : ("implementation_retry" as const);
              const plan: Plan | null =
                mode === "review_rework" || mode === "implementation_retry"
                  ? ((await loadLatestPlanByStatus(input.database, workRef, "approved")) ??
                    (await loadLatestPlanByStatus(input.database, workRef, "validated")) ??
                    (mode === "implementation_retry"
                      ? await loadLatestPlanByStatus(input.database, workRef, "rejected")
                      : null))
                  : await loadLatestPlanByStatus(
                      input.database,
                      workRef,
                      mode === "approved_plan" ? "approved" : "rejected",
                    );
              if (!plan && mode !== "implementation_retry") {
                throw new Error(`scheduler.ready_implementation_handoff_missing:${systemJobId}`);
              }
              let changeClass: "standard" | "high_risk" = "high_risk";
              let source: ImplementationContinuationSource;
              if (mode === "review_rework") {
                const reviewSource = await loadReviewReworkSource({
                  collectEvidence: input.review?.collectEvidence,
                  database: input.database,
                  environment: input.environment,
                  issue: job,
                  timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
                  workspaceRoot: stringValue(values, "workspace.root"),
                });
                if (!reviewSource || !plan) {
                  throw new Error(`scheduler.ready_implementation_handoff_missing:${systemJobId}`);
                }
                changeClass = reviewSource.changeClass;
                source = {
                  kind: "review",
                  result: reviewResultForRework(job, plan.revision, reviewSource),
                };
              } else if (mode === "implementation_retry") {
                const retry = await loadPendingImplementationRetry(input.database, workRef);
                if (!retry) {
                  throw new Error(`scheduler.ready_implementation_handoff_missing:${systemJobId}`);
                }
                changeClass = retry.changeClass;
                source = {
                  findings: retryFindings(retry.source),
                  handoff: retry.handoff,
                  kind: "retry",
                  reason: retry.reason,
                  routingFacts: retry.routingFacts,
                  summary: retry.source.summary,
                };
              } else {
                const review = await loadLatestPlanReviewResult(input.database, workRef);
                if (!review) {
                  throw new Error(`scheduler.ready_implementation_handoff_missing:${systemJobId}`);
                }
                source = { kind: "review", result: review.result };
              }
              const implementationPlanned = await planImplementationContinuation({
                adapter: agent,
                changeClass,
                configSnapshotId: input.snapshot.id,
                configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
                database: input.database,
                issue: job,
                mode,
                newId: randomUUID,
                now: () => new Date().toISOString(),
                plan,
                source,
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
                issue: job,
                maxFailureRetries: numberValue(values, "agent.max_failure_retries"),
                maxRetryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
                maxReworkCycles: numberValue(values, "agent.max_rework_cycles"),
                newId: randomUUID,
                now: () => new Date().toISOString(),
                onPlanSubmitted: createInitialPlanSubmissionHandler({
                  attemptId: implementationPlanned.attemptId,
                  database: input.database,
                  issue: job,
                  now: () => new Date().toISOString(),
                  provisionalClassification: {
                    changeClass,
                    floor: changeClass,
                    reasons: [`classification.system_job_${mode}`],
                  },
                  riskPathPatterns: stringList(values, "class.risk_paths"),
                  safety,
                  trivialMaxChangedLines: numberValue(values, "class.trivial_max_changed_lines"),
                  trivialPathPatterns: stringList(values, "class.trivial_patterns"),
                  workspacePath: implementationPlanned.dispatch.attempt.workspacePath,
                }),
                planned: implementationPlanned,
                repositoryAdapter,
                retryJitterSample: Math.random(),
                safety,
                serviceRunId: input.serviceRunId,
                sourceEnvironment: input.environment,
                usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
                workspaceRoot: stringValue(values, "workspace.root"),
              });
              planned = implementationPlanned;
            }
            availableSlots -= 1;
            runningSystemJobAttempts.add(planned.attemptId);
            running.set(planned.attemptId, {
              attemptId: planned.attemptId,
              attemptLane: "running",
              expectedExpiresAt: planned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId: systemJobId,
              lastEventAt: started.bound.started.timestamp,
              processGroupId: started.bound.session.processGroupId,
              processId: started.bound.session.processId,
              workspacePath: planned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              started.completion,
              () => {
                running.delete(planned.attemptId);
                runningSystemJobAttempts.delete(planned.attemptId);
              },
              (error) =>
                input.logger?.error(
                  { attempt_id: planned.attemptId, error, system_job_id: systemJobId },
                  "repair SystemJob continuation lifecycle failed",
                ),
            );
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob continuation skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isIndependentVerification && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const target = await loadPendingIndependentVerification(
              input.database,
              { id: systemJobId, kind: "system_job" },
              claim.reason,
            );
            if (!target) {
              throw new Error(`scheduler.verification_target_missing:${systemJobId}`);
            }
            await runPendingIndependentVerification({
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              command: stringValue(values, "workspace.verify_command"),
              database: input.database,
              expectedReadyReason: claim.reason,
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
              verifiedReadyReason: "pull_request_required",
              workRef: { id: systemJobId, kind: "system_job" },
              workspaceRoot: stringValue(values, "workspace.root"),
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob verification skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isRepositoryPublication && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const target = await loadPendingRepairPublication(input.database, systemJobId);
            await executeRepairRepositoryPublication({
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              failedMergeSha: target.failedMergeSha,
              job,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              readWorkspaceRevision: () =>
                input.verification?.readRevision
                  ? input.verification.readRevision({
                      sourceEnvironment: input.environment,
                      timeoutMs: numberValue(values, "hooks.timeout_ms"),
                      workspace: target.workspacePath,
                      workspaceRoot: stringValue(values, "workspace.root"),
                    })
                  : readWorkspaceHeadRevision({
                      commandRunner: createNodeWorkspaceCommandRunner(),
                      environment: input.environment,
                      timeoutMs: numberValue(values, "hooks.timeout_ms"),
                      workspace: target.workspacePath,
                      workspaceRoot: stringValue(values, "workspace.root"),
                    }),
              repository: repositoryHostingAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              target,
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob publication skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isPullRequestHygiene && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const target = await loadPendingPullRequestGate(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!target) throw new Error(`scheduler.pull_request_gate_missing:${systemJobId}`);
            await runPullRequestHygiene({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              fetchPullRequestSnapshot: (workRef) =>
                repositoryHostingAdapter.fetchPullRequestSnapshot(workRef),
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              quietPeriodMs: numberValue(values, "review.quiet_period_ms"),
              requiredChecks: stringList(values, "review.required_checks"),
              settleTimeoutMs: numberValue(values, "review.settle_timeout_ms"),
              target,
              workRef: { id: systemJobId, kind: "system_job" },
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob pull-request hygiene skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isIntegrativeReview && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const target = await loadPendingIntegrativeReview(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!target) throw new Error(`scheduler.review_target_missing:${systemJobId}`);
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
            const planned = await planIntegrativeReviewAttempt({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              context,
              database: input.database,
              issue: job,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              serviceRunId: input.serviceRunId,
              terminalResultSchema: ReviewResultSchema,
            });
            const started = await startPlannedIntegrativeReviewAttemptLifecycle({
              adapter: agent,
              agentCommand: stringValue(values, "agent.command"),
              afterCreateCommand: nullableString(values, "hooks.after_create"),
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
              beforeRunCommand: nullableString(values, "hooks.before_run"),
              database: input.database,
              hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
              issue: job,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              planned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            availableSlots -= 1;
            runningSystemJobAttempts.add(planned.attemptId);
            running.set(planned.attemptId, {
              attemptId: planned.attemptId,
              attemptLane: "review",
              expectedExpiresAt: planned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId: systemJobId,
              lastEventAt: started.bound.started.timestamp,
              processGroupId: started.bound.session.processGroupId,
              processId: started.bound.session.processId,
              workspacePath: planned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              started.completion,
              () => {
                running.delete(planned.attemptId);
                runningSystemJobAttempts.delete(planned.attemptId);
              },
              (error) =>
                input.logger?.error(
                  { attempt_id: planned.attemptId, error, system_job_id: systemJobId },
                  "repair SystemJob integrative review lifecycle failed",
                ),
            );
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob integrative review skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isReviewCoordination && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const pending = await loadPendingReviewCoordination(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!pending) {
              throw new Error(`scheduler.review_coordination_missing:${systemJobId}`);
            }
            let requiredSpecialistNames: readonly string[] = [];
            if (pending.changeClass === "high_risk") {
              const context = await (
                input.review?.collectEvidence ?? collectIntegrativeReviewContext
              )({
                baseSha: pending.targetBaseSha,
                changeClass: pending.changeClass,
                commandRunner: createNodeWorkspaceCommandRunner(),
                sourceEnvironment: input.environment,
                targetSha: pending.targetSha,
                timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
                verificationRecordId: pending.verificationRecordId,
                workspace: pending.workspacePath,
                workspaceRoot: stringValue(values, "workspace.root"),
              });
              requiredSpecialistNames = selectRequiredSpecialists(
                parseReviewSpecialists(values["review.specialists"]),
                {
                  acceptanceCriteriaPresent: job.acceptance_criteria.length > 0,
                  changedLines: context.changedLines,
                  changedPaths: context.changedFiles,
                  facts: new Set(pending.riskFacts),
                  proposedPaths: pending.proposedPaths,
                },
              ).map((required) => required.specialist.name);
              const routed = await routeNextReviewSpecialist(input.database, {
                requiredSpecialistNames,
                updatedAt: new Date().toISOString(),
                workRef: { id: systemJobId, kind: "system_job" },
              });
              if (routed) continue;
            }
            const conflicts = await routeReviewAdjudication(input.database, {
              updatedAt: new Date().toISOString(),
              workRef: { id: systemJobId, kind: "system_job" },
            });
            if (conflicts.length > 0) continue;
            await commitOrdinaryReviewSet(input.database, {
              createdAt: new Date().toISOString(),
              id: randomUUID(),
              requiredSpecialistNames,
              workRef: { id: systemJobId, kind: "system_job" },
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob review coordination skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if ((isSpecialistReview || isAdjudication) && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const pending = await loadPendingReviewCoordination(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!pending) throw new Error(`scheduler.review_target_missing:${systemJobId}`);
            const context = await (
              input.review?.collectEvidence ?? collectIntegrativeReviewContext
            )({
              baseSha: pending.targetBaseSha,
              changeClass: pending.changeClass,
              commandRunner: createNodeWorkspaceCommandRunner(),
              sourceEnvironment: input.environment,
              targetSha: pending.targetSha,
              timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
              verificationRecordId: pending.verificationRecordId,
              workspace: pending.workspacePath,
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            let planned: Awaited<ReturnType<typeof planSpecialistReviewAttempt>>;
            let started: Awaited<ReturnType<typeof startPlannedSpecialistReviewAttemptLifecycle>>;
            if (isSpecialistReview) {
              const specialistName = decodeSpecialistName(claim.reason);
              const selection = selectRequiredSpecialists(
                parseReviewSpecialists(values["review.specialists"]),
                {
                  acceptanceCriteriaPresent: job.acceptance_criteria.length > 0,
                  changedLines: context.changedLines,
                  changedPaths: context.changedFiles,
                  facts: new Set(pending.riskFacts),
                  proposedPaths: pending.proposedPaths,
                },
              ).find((candidate) => candidate.specialist.name === specialistName);
              if (!selection) {
                throw new Error(`scheduler.specialist_no_longer_required:${specialistName}`);
              }
              planned = await planSpecialistReviewAttempt({
                adapter: agent,
                configSnapshotId: input.snapshot.id,
                configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
                context,
                database: input.database,
                issue: job,
                newId: randomUUID,
                now: () => new Date().toISOString(),
                selection,
                serviceRunId: input.serviceRunId,
                terminalResultSchema: ReviewResultSchema,
              });
              started = await startPlannedSpecialistReviewAttemptLifecycle({
                adapter: agent,
                agentCommand: stringValue(values, "agent.command"),
                afterCreateCommand: nullableString(values, "hooks.after_create"),
                allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
                attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
                beforeRunCommand: nullableString(values, "hooks.before_run"),
                database: input.database,
                hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
                issue: job,
                newId: randomUUID,
                now: () => new Date().toISOString(),
                planned,
                repositoryAdapter,
                safety,
                serviceRunId: input.serviceRunId,
                sourceEnvironment: input.environment,
                specialistName,
                usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
                workspaceRoot: stringValue(values, "workspace.root"),
              });
            } else {
              const rejectedFindingIds = new Set(pending.rejectedFindingIds);
              const summaries = pending.records.map((record) => ({
                decision: record.decision,
                findings: record.findings
                  .filter((finding) => !rejectedFindingIds.has(finding.id))
                  .map((finding) => ({
                    behavior: finding.behavior,
                    blocking: finding.blocking,
                    disposition: finding.disposition,
                    evidenceKey: JSON.stringify(finding.evidence),
                    id: finding.id,
                  })),
                reviewer: record.reviewer,
                targetSha: record.targetSha,
              }));
              const conflicts = findContraryReviewFindings(summaries).map((conflict) => ({
                conflictId: conflict.conflictId,
                findings: pending.records.flatMap((record) =>
                  record.findings
                    .filter(
                      (finding) =>
                        !rejectedFindingIds.has(finding.id) &&
                        conflict.findingIds.includes(finding.id),
                    )
                    .map((finding) => ({
                      behavior: finding.behavior,
                      disposition: finding.disposition,
                      evidence: finding.evidence,
                      id: finding.id,
                      reviewer: record.reviewer,
                      severity: finding.severity,
                    })),
                ),
              }));
              planned = await planAdjudicationAttempt({
                adapter: agent,
                configSnapshotId: input.snapshot.id,
                configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
                conflicts,
                context,
                database: input.database,
                issue: job,
                newId: randomUUID,
                now: () => new Date().toISOString(),
                serviceRunId: input.serviceRunId,
                terminalResultSchema: AdjudicationResultSchema,
              });
              started = await startPlannedAdjudicationAttemptLifecycle({
                adapter: agent,
                agentCommand: stringValue(values, "agent.command"),
                afterCreateCommand: nullableString(values, "hooks.after_create"),
                allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
                attemptTokenCap: numberValue(values, "budget.per_attempt_tokens"),
                beforeRunCommand: nullableString(values, "hooks.before_run"),
                database: input.database,
                hookTimeoutMs: numberValue(values, "hooks.timeout_ms"),
                issue: job,
                newId: randomUUID,
                now: () => new Date().toISOString(),
                planned,
                repositoryAdapter,
                safety,
                serviceRunId: input.serviceRunId,
                sourceEnvironment: input.environment,
                usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
                workspaceRoot: stringValue(values, "workspace.root"),
              });
            }
            availableSlots -= 1;
            runningSystemJobAttempts.add(planned.attemptId);
            running.set(planned.attemptId, {
              attemptId: planned.attemptId,
              attemptLane: "review",
              expectedExpiresAt: planned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId: systemJobId,
              lastEventAt: started.bound.started.timestamp,
              processGroupId: started.bound.session.processGroupId,
              processId: started.bound.session.processId,
              workspacePath: planned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              started.completion,
              () => {
                running.delete(planned.attemptId);
                runningSystemJobAttempts.delete(planned.attemptId);
              },
              (error) =>
                input.logger?.error(
                  { attempt_id: planned.attemptId, error, system_job_id: systemJobId },
                  "repair SystemJob specialist or adjudication lifecycle failed",
                ),
            );
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob specialist or adjudication skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          continue;
        }
        if (isMergeQueue && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            if (repositoryMergeActive) continue;
            const target = await loadPendingMergeQueue(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!target) throw new Error(`scheduler.merge_queue_target_missing:${systemJobId}`);
            await executeMergeQueueLanding({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              landingPolicy: "squash",
              newId: randomUUID,
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              repository: repositoryHostingAdapter,
              requiredChecks: stringList(values, "review.required_checks"),
              safety,
              serviceRunId: input.serviceRunId,
              target,
              workRef: { id: systemJobId, kind: "system_job" },
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob merge queue skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          break;
        }
        if (isPostMerge && "system_job_id" in claim.work_ref) {
          const systemJobId = claim.work_ref.system_job_id;
          try {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const job = await loadSystemJob(input.database, systemJobId);
            if (job?.kind !== "repair") {
              throw new Error(`scheduler.ready_repair_job_missing:${systemJobId}`);
            }
            const target = await loadPendingPostMerge(input.database, {
              id: systemJobId,
              kind: "system_job",
            });
            if (!target) throw new Error(`scheduler.post_merge_target_missing:${systemJobId}`);
            await executeSystemJobPostMergeVerification({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              job,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              repository: repositoryHostingAdapter,
              requiredChecks: stringList(values, "review.required_checks"),
              safety,
              settleTimeoutMs: numberValue(values, "review.settle_timeout_ms"),
              target,
              workRef: { id: systemJobId, kind: "system_job" },
              workspaceRoot: stringValue(values, "workspace.root"),
            });
          } catch (error) {
            input.logger?.warn(
              { error, system_job_id: systemJobId },
              "repair SystemJob post-merge verification skipped scheduler tick",
            );
            if (!safety.canDispatch()) throw error;
          }
          break;
        }
        if (!("issue_id" in claim.work_ref)) continue;
        const issueId = claim.work_ref.issue_id;
        try {
          const stored = await loadIssue(input.database, issueId);
          if (!stored) throw new Error(`scheduler.ready_issue_missing:${issueId}`);
          if (isRepairParentCompletion) {
            await executeRepairParentCompletion({
              configSnapshotId: input.snapshot.id,
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              issueId,
              lane: claim.reason === "repair_completed" ? "Review" : "Done",
              newId: randomUUID,
              now: () => new Date().toISOString(),
              providerRevision: stored.providerRevision,
              safety,
              serviceRunId: input.serviceRunId,
              tracker,
            });
            continue;
          }
          if (isRepositoryPublication) {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const target = await loadPendingRepositoryPublication(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.publication_target_missing:${issueId}`);
            await executeRepositoryPublication({
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              providerRevision: stored.providerRevision,
              readWorkspaceRevision: () =>
                input.verification?.readRevision
                  ? input.verification.readRevision({
                      sourceEnvironment: input.environment,
                      timeoutMs: numberValue(values, "hooks.timeout_ms"),
                      workspace: target.workspacePath,
                      workspaceRoot: stringValue(values, "workspace.root"),
                    })
                  : readWorkspaceHeadRevision({
                      commandRunner: createNodeWorkspaceCommandRunner(),
                      environment: input.environment,
                      timeoutMs: numberValue(values, "hooks.timeout_ms"),
                      workspace: target.workspacePath,
                      workspaceRoot: stringValue(values, "workspace.root"),
                    }),
              repository: repositoryHostingAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              target,
              tracker,
            });
            continue;
          }
          if (isPullRequestHygiene) {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const target = await loadPendingPullRequestGate(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.pull_request_gate_missing:${issueId}`);
            await runPullRequestHygiene({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              fetchPullRequestSnapshot: (workRef) =>
                repositoryHostingAdapter.fetchPullRequestSnapshot(workRef),
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              quietPeriodMs: numberValue(values, "review.quiet_period_ms"),
              requiredChecks: stringList(values, "review.required_checks"),
              settleTimeoutMs: numberValue(values, "review.settle_timeout_ms"),
              target,
              workRef: { id: issueId, kind: "issue" },
            });
            continue;
          }
          if (isMergeQueue) {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            if (repositoryMergeActive) continue;
            const target = await loadPendingMergeQueue(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.merge_queue_target_missing:${issueId}`);
            await executeMergeQueueLanding({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              landingPolicy: "squash",
              newId: randomUUID,
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              repository: repositoryHostingAdapter,
              requiredChecks: stringList(values, "review.required_checks"),
              safety,
              serviceRunId: input.serviceRunId,
              target,
              workRef: { id: issueId, kind: "issue" },
            });
            break;
          }
          if (isPostMerge) {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            const target = await loadPendingPostMerge(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.post_merge_target_missing:${issueId}`);
            await executePostMergeVerification({
              acceptedCheckConclusions: stringList(values, "review.accepted_check_conclusions"),
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              pollIntervalMs: numberValue(values, "polling.interval_ms"),
              repository: repositoryHostingAdapter,
              requiredChecks: stringList(values, "review.required_checks"),
              safety,
              serviceRunId: input.serviceRunId,
              settleTimeoutMs: numberValue(values, "review.settle_timeout_ms"),
              target,
              tracker,
              workRef: { id: issueId, kind: "issue" },
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            break;
          }
          if (isReviewCoordination) {
            const pending = await loadPendingReviewCoordination(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!pending) throw new Error(`scheduler.review_coordination_missing:${issueId}`);
            let requiredSpecialistNames: readonly string[] = [];
            if (pending.changeClass === "high_risk") {
              const context = await (
                input.review?.collectEvidence ?? collectIntegrativeReviewContext
              )({
                baseSha: pending.targetBaseSha,
                changeClass: pending.changeClass,
                commandRunner: createNodeWorkspaceCommandRunner(),
                sourceEnvironment: input.environment,
                targetSha: pending.targetSha,
                timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
                verificationRecordId: pending.verificationRecordId,
                workspace: pending.workspacePath,
                workspaceRoot: stringValue(values, "workspace.root"),
              });
              const facts = new Set(pending.riskFacts);
              for (const label of stored.issue.labels) facts.add(`label:${label}`);
              requiredSpecialistNames = selectRequiredSpecialists(
                parseReviewSpecialists(values["review.specialists"]),
                {
                  acceptanceCriteriaPresent: stored.issue.acceptance_criteria.length > 0,
                  changedLines: context.changedLines,
                  changedPaths: context.changedFiles,
                  facts,
                  proposedPaths: pending.proposedPaths,
                },
              ).map((required) => required.specialist.name);
              const routed = await routeNextReviewSpecialist(input.database, {
                requiredSpecialistNames,
                updatedAt: new Date().toISOString(),
                workRef: { id: issueId, kind: "issue" },
              });
              if (routed) continue;
            }
            const conflicts = await routeReviewAdjudication(input.database, {
              updatedAt: new Date().toISOString(),
              workRef: { id: issueId, kind: "issue" },
            });
            if (conflicts.length > 0) continue;
            await commitOrdinaryReviewSet(input.database, {
              createdAt: new Date().toISOString(),
              id: randomUUID(),
              requiredSpecialistNames,
              workRef: { id: issueId, kind: "issue" },
            });
            continue;
          }
          if (isIndependentVerification) {
            const target = await loadPendingIndependentVerification(
              input.database,
              {
                id: issueId,
                kind: "issue",
              },
              claim.reason,
            );
            if (!target) throw new Error(`scheduler.verification_target_missing:${issueId}`);
            await runPendingIndependentVerification({
              allowlistedEnvironmentNames: stringList(values, "env.allowlist"),
              command: stringValue(values, "workspace.verify_command"),
              database: input.database,
              expectedReadyReason: claim.reason,
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
              verifiedReadyReason: isBaseUpdateVerification
                ? "pull_request_hygiene_required"
                : "pull_request_required",
              workRef: { id: issueId, kind: "issue" },
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            continue;
          }
          if (isBaseUpdate) {
            if (!repositoryHostingAdapter) throw new Error("scheduler.repository_adapter_missing");
            if (repositoryMergeActive) continue;
            const target = await loadPendingBaseUpdate(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!target) throw new Error(`scheduler.base_update_target_missing:${issueId}`);
            await executeBaseUpdate({
              database: input.database,
              expiresAt: new Date(
                Date.now() + numberValue(values, "persistence.lease_ttl_ms"),
              ).toISOString(),
              newId: randomUUID,
              now: () => new Date().toISOString(),
              repository: repositoryHostingAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              syncWorkspace:
                input.repositorySync ??
                ((request) =>
                  syncWorkspaceToPublishedBranch({
                    ...request,
                    commandRunner: createNodeWorkspaceCommandRunner(),
                    environment: input.environment,
                    timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
                    workspaceRoot: stringValue(values, "workspace.root"),
                  })),
              target,
              workRef: { id: issueId, kind: "issue" },
            });
            break;
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
          if (isSpecialistReview) {
            const specialistName = decodeSpecialistName(claim.reason);
            const pending = await loadPendingReviewCoordination(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!pending) throw new Error(`scheduler.specialist_target_missing:${issueId}`);
            const context = await (
              input.review?.collectEvidence ?? collectIntegrativeReviewContext
            )({
              baseSha: pending.targetBaseSha,
              changeClass: pending.changeClass,
              commandRunner: createNodeWorkspaceCommandRunner(),
              sourceEnvironment: input.environment,
              targetSha: pending.targetSha,
              timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
              verificationRecordId: pending.verificationRecordId,
              workspace: pending.workspacePath,
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            const facts = new Set(pending.riskFacts);
            for (const label of stored.issue.labels) facts.add(`label:${label}`);
            const selection = selectRequiredSpecialists(
              parseReviewSpecialists(values["review.specialists"]),
              {
                acceptanceCriteriaPresent: stored.issue.acceptance_criteria.length > 0,
                changedLines: context.changedLines,
                changedPaths: context.changedFiles,
                facts,
                proposedPaths: pending.proposedPaths,
              },
            ).find((candidate) => candidate.specialist.name === specialistName);
            if (!selection) {
              throw new Error(`scheduler.specialist_no_longer_required:${specialistName}`);
            }
            const specialistPlanned = await planSpecialistReviewAttempt({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              context,
              database: input.database,
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              selection,
              serviceRunId: input.serviceRunId,
              terminalResultSchema: ReviewResultSchema,
            });
            const specialistStarted = await startPlannedSpecialistReviewAttemptLifecycle({
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
              planned: specialistPlanned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              specialistName,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            availableSlots -= 1;
            running.set(specialistPlanned.attemptId, {
              attemptId: specialistPlanned.attemptId,
              attemptLane: "In Progress",
              expectedExpiresAt: specialistPlanned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId,
              lastEventAt: specialistStarted.bound.started.timestamp,
              processGroupId: specialistStarted.bound.session.processGroupId,
              processId: specialistStarted.bound.session.processId,
              workspacePath: specialistPlanned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              specialistStarted.completion,
              () => running.delete(specialistPlanned.attemptId),
              (error) =>
                input.logger?.error(
                  { attempt_id: specialistPlanned.attemptId, error },
                  "specialist review lifecycle failed",
                ),
            );
            continue;
          }
          if (isAdjudication) {
            const pending = await loadPendingReviewCoordination(input.database, {
              id: issueId,
              kind: "issue",
            });
            if (!pending) throw new Error(`scheduler.adjudication_target_missing:${issueId}`);
            const context = await (
              input.review?.collectEvidence ?? collectIntegrativeReviewContext
            )({
              baseSha: pending.targetBaseSha,
              changeClass: pending.changeClass,
              commandRunner: createNodeWorkspaceCommandRunner(),
              sourceEnvironment: input.environment,
              targetSha: pending.targetSha,
              timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
              verificationRecordId: pending.verificationRecordId,
              workspace: pending.workspacePath,
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            const rejectedFindingIds = new Set(pending.rejectedFindingIds);
            const summaries = pending.records.map((record) => ({
              decision: record.decision,
              findings: record.findings
                .filter((finding) => !rejectedFindingIds.has(finding.id))
                .map((finding) => ({
                  behavior: finding.behavior,
                  blocking: finding.blocking,
                  disposition: finding.disposition,
                  evidenceKey: JSON.stringify(finding.evidence),
                  id: finding.id,
                })),
              reviewer: record.reviewer,
              targetSha: record.targetSha,
            }));
            const conflicts = findContraryReviewFindings(summaries).map((conflict) => ({
              conflictId: conflict.conflictId,
              findings: pending.records.flatMap((record) =>
                record.findings
                  .filter(
                    (finding) =>
                      !rejectedFindingIds.has(finding.id) &&
                      conflict.findingIds.includes(finding.id),
                  )
                  .map((finding) => ({
                    behavior: finding.behavior,
                    disposition: finding.disposition,
                    evidence: finding.evidence,
                    id: finding.id,
                    reviewer: record.reviewer,
                    severity: finding.severity,
                  })),
              ),
            }));
            const adjudicationPlanned = await planAdjudicationAttempt({
              adapter: agent,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              conflicts,
              context,
              database: input.database,
              issue: stored.issue,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              serviceRunId: input.serviceRunId,
              terminalResultSchema: AdjudicationResultSchema,
            });
            const adjudicationStarted = await startPlannedAdjudicationAttemptLifecycle({
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
              planned: adjudicationPlanned,
              repositoryAdapter,
              safety,
              serviceRunId: input.serviceRunId,
              sourceEnvironment: input.environment,
              usdCap: positiveNumberValue(values, "budget.per_attempt_usd"),
              workspaceRoot: stringValue(values, "workspace.root"),
            });
            availableSlots -= 1;
            running.set(adjudicationPlanned.attemptId, {
              attemptId: adjudicationPlanned.attemptId,
              attemptLane: "In Progress",
              expectedExpiresAt: adjudicationPlanned.dispatch.claim.expiresAt,
              holder: input.serviceRunId,
              issueId,
              lastEventAt: adjudicationStarted.bound.started.timestamp,
              processGroupId: adjudicationStarted.bound.session.processGroupId,
              processId: adjudicationStarted.bound.session.processId,
              workspacePath: adjudicationPlanned.dispatch.attempt.workspacePath,
            });
            trackCompletion(
              completions,
              adjudicationStarted.completion,
              () => running.delete(adjudicationPlanned.attemptId),
              (error) =>
                input.logger?.error(
                  { attempt_id: adjudicationPlanned.attemptId, error },
                  "adjudication lifecycle failed",
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
                : claim.reason === "plan_revision_required"
                  ? ("plan_revision" as const)
                  : isReviewRework
                    ? ("review_rework" as const)
                    : ("implementation_retry" as const);
            const workRef = { id: issueId, kind: "issue" as const };
            const plan: Plan | null =
              mode === "review_rework" || mode === "implementation_retry"
                ? ((await loadLatestPlanByStatus(input.database, workRef, "approved")) ??
                  (await loadLatestPlanByStatus(input.database, workRef, "validated")) ??
                  (mode === "implementation_retry"
                    ? await loadLatestPlanByStatus(input.database, workRef, "rejected")
                    : null))
                : await loadLatestPlanByStatus(
                    input.database,
                    workRef,
                    mode === "approved_plan" ? "approved" : "rejected",
                  );
            if (!plan && mode !== "implementation_retry") {
              throw new Error(`scheduler.ready_implementation_handoff_missing:${issueId}`);
            }
            let changeClass: "standard" | "high_risk" = "high_risk";
            let source: ImplementationContinuationSource;
            if (mode === "review_rework") {
              const reviewSource = await loadReviewReworkSource({
                collectEvidence: input.review?.collectEvidence,
                database: input.database,
                environment: input.environment,
                issue: stored.issue,
                timeoutMs: numberValue(values, "review.snapshot_timeout_ms"),
                workspaceRoot: stringValue(values, "workspace.root"),
              });
              if (!reviewSource || !plan) {
                throw new Error(`scheduler.ready_implementation_handoff_missing:${issueId}`);
              }
              changeClass = reviewSource.changeClass;
              source = {
                kind: "review",
                result: reviewResultForRework(stored.issue, plan.revision, reviewSource),
              };
            } else if (mode === "implementation_retry") {
              const retry = await loadPendingImplementationRetry(input.database, workRef);
              if (!retry) {
                throw new Error(`scheduler.ready_implementation_handoff_missing:${issueId}`);
              }
              changeClass = retry.changeClass;
              source = {
                findings: retryFindings(retry.source),
                handoff: retry.handoff,
                kind: "retry",
                reason: retry.reason,
                routingFacts: retry.routingFacts,
                summary: retry.source.summary,
              };
            } else {
              const review = await loadLatestPlanReviewResult(input.database, workRef);
              if (!review) {
                throw new Error(`scheduler.ready_implementation_handoff_missing:${issueId}`);
              }
              source = { kind: "review", result: review.result };
            }
            const implementationPlanned = await planImplementationContinuation({
              adapter: agent,
              changeClass,
              configSnapshotId: input.snapshot.id,
              configuration: initialAttemptConfiguration(values, input.prompt, input.environment),
              database: input.database,
              issue: stored.issue,
              mode,
              newId: randomUUID,
              now: () => new Date().toISOString(),
              plan,
              source,
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
              maxFailureRetries: numberValue(values, "agent.max_failure_retries"),
              maxRetryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
              maxReworkCycles: numberValue(values, "agent.max_rework_cycles"),
              newId: randomUUID,
              now: () => new Date().toISOString(),
              onPlanSubmitted: createInitialPlanSubmissionHandler({
                attemptId: implementationPlanned.attemptId,
                database: input.database,
                issue: stored.issue,
                now: () => new Date().toISOString(),
                provisionalClassification: {
                  changeClass,
                  floor: changeClass,
                  reasons: [
                    mode === "review_rework"
                      ? "classification.review_rework"
                      : mode === "implementation_retry" && source.kind === "retry"
                        ? `classification.retry:${source.reason}`
                        : "classification.reviewed_high_risk_plan",
                  ],
                },
                riskPathPatterns: stringList(values, "class.risk_paths"),
                safety,
                trivialMaxChangedLines: numberValue(values, "class.trivial_max_changed_lines"),
                trivialPathPatterns: stringList(values, "class.trivial_patterns"),
                workspacePath: implementationPlanned.dispatch.attempt.workspacePath,
              }),
              planned: implementationPlanned,
              repositoryAdapter,
              retryJitterSample: Math.random(),
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
            maxFailureRetries: numberValue(values, "agent.max_failure_retries"),
            maxRetryBackoffMs: numberValue(values, "agent.max_retry_backoff_ms"),
            maxReworkCycles: numberValue(values, "agent.max_rework_cycles"),
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
            retryJitterSample: Math.random(),
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

type ReworkReviewResult = Extract<PlanReviewResult, { decision: "needs_rework" }>;

function retryFindings(source: {
  evidence: readonly unknown[];
  status: string;
  summary: string;
}): readonly unknown[] {
  return [
    {
      evidence: source.evidence,
      status: source.status,
      summary: source.summary,
    },
  ];
}

interface ReviewReworkSource {
  changeClass: "standard" | "high_risk";
  changedFiles: readonly string[];
  findings: ReworkReviewResult["findings"];
  targetSha: string;
  verificationRecordId: string;
}

async function loadReviewReworkSource(input: {
  collectEvidence: typeof collectIntegrativeReviewContext | undefined;
  database: OpenedDatabase["database"];
  environment: Readonly<Record<string, string | undefined>>;
  issue: Issue | Extract<SystemJob, { kind: "repair" }>;
  timeoutMs: number;
  workspaceRoot: string;
}): Promise<ReviewReworkSource | null> {
  const pending = await loadPendingReviewCoordination(input.database, {
    id: input.issue.id,
    kind: "kind" in input.issue ? "system_job" : "issue",
  });
  if (!pending || pending.unresolvedBlockingFindingIds.length === 0) return null;
  const context = await (input.collectEvidence ?? collectIntegrativeReviewContext)({
    baseSha: pending.targetBaseSha,
    changeClass: pending.changeClass,
    commandRunner: createNodeWorkspaceCommandRunner(),
    sourceEnvironment: input.environment,
    targetSha: pending.targetSha,
    timeoutMs: input.timeoutMs,
    verificationRecordId: pending.verificationRecordId,
    workspace: pending.workspacePath,
    workspaceRoot: input.workspaceRoot,
  });
  const unresolved = new Set(pending.unresolvedBlockingFindingIds);
  const findings = pending.records.flatMap((record) =>
    record.findings
      .filter((finding) => finding.blocking && unresolved.has(finding.id))
      .map((finding) => ({
        behavior: `${finding.behavior}\nRequired disposition: ${finding.disposition}`,
        blocking: true as const,
        evidence: finding.evidence,
        id: finding.id,
        severity: finding.severity,
      })),
  );
  if (findings.length !== unresolved.size) {
    throw new Error("scheduler.review_rework_findings_incomplete");
  }
  return {
    changeClass: pending.changeClass,
    changedFiles: context.changedFiles,
    findings,
    targetSha: pending.targetSha,
    verificationRecordId: pending.verificationRecordId,
  };
}

function reviewResultForRework(
  issue: Issue | Extract<SystemJob, { kind: "repair" }>,
  planRevision: number,
  source: ReviewReworkSource,
): ReworkReviewResult {
  return {
    decision: "needs_rework",
    evidence: source.findings.flatMap((finding) => finding.evidence),
    findings: source.findings,
    handoff: {
      acceptance_criteria: issue.acceptance_criteria,
      commands: [
        { command: `orchestrator verification ${source.verificationRecordId}`, exit_code: 0 },
      ],
      decisions_fixed: [],
      files_changed: [...source.changedFiles],
      goal: "kind" in issue ? issue.goal : issue.title,
      open_items: source.findings.map((finding) => finding.behavior),
      revision: source.targetSha,
    },
    plan_revision: planRevision,
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
  return provisionalClassificationForAttempt(planned.record.dispatch.attempt);
}

function provisionalClassificationForAttempt(attempt: {
  changeClass: "high_risk" | "standard" | "trivial";
  routingReasons: readonly string[];
}): ProvisionalClassification {
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

function decodeSpecialistName(reason: string): string {
  const encoded = reason.slice("specialist_review_required:".length);
  try {
    const name = decodeURIComponent(encoded);
    if (!name || encodeURIComponent(name) !== encoded) throw new Error("invalid");
    return name;
  } catch {
    throw new Error("scheduler.specialist_reason_invalid");
  }
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
    populateSystemJobWorkspace: (request) => {
      const operation = load().populateSystemJobWorkspace;
      if (!operation) throw new Error("workspace.system_job_population_unsupported");
      return operation(request);
    },
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
