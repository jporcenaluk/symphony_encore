import { randomUUID } from "node:crypto";
import {
  createGhCliApiClient,
  createGitHubProjectsTransport,
  createGitHubTrackerAdapter,
  createNodeGhCommandRunner,
  type TrackerAdapter,
  terminateLinuxProcessGroup,
} from "@symphony/adapters";
import { PersistenceSafetyController, SchedulerService } from "@symphony/orchestration";
import {
  type ConfigurationSnapshot,
  type OpenedDatabase,
  observeIssue,
} from "@symphony/persistence";

import { syncTrackerCandidates } from "./candidate-sync.js";
import {
  createPersistentRunningIssueReconciler,
  type RunningIssueRecord,
} from "./running-issue-reconciler.js";

interface SchedulerLogger {
  error(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export function createProductionScheduler(input: {
  database: OpenedDatabase["database"];
  environment: Readonly<Record<string, string | undefined>>;
  logger?: SchedulerLogger;
  serviceRunId: string;
  snapshot: ConfigurationSnapshot;
  tracker?: TrackerAdapter;
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
  return new SchedulerService({
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
      try {
        await syncTrackerCandidates({
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
      }
    },
  });
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
