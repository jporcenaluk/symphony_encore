import {
  collectAllPages,
  removeTerminalWorkspace,
  runLinuxHook,
  type TrackerAdapter,
  terminateLinuxProcessGroup,
} from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import {
  type PersistenceSafetyController,
  type RunningAttemptSnapshot,
  type RunningReconciliationDecision,
  reconcileRunningAttempts,
} from "@symphony/orchestration";
import {
  closeRunningAttemptForReconciliation,
  listRunningIssueAttempts,
  listRunningSystemJobAttempts,
  type OpenedDatabase,
  observeIssue,
  renewRunningClaim,
} from "@symphony/persistence";

const TRACKER_STATES = ["Backlog", "Todo", "In Progress", "Review", "Human", "Done"] as const;

export interface RunningIssueRecord extends RunningAttemptSnapshot {
  expectedExpiresAt: string;
  holder: string;
  processGroupId: number;
  processId: number;
}

export interface RunningIssueCloseDecision {
  failureClass: "agent_process" | "task";
  nextClaim: "ready" | "release" | "retry";
  reason: string;
  retryDueAt: string | null;
  summary: string;
  terminalResultId: string;
}

export interface RunningIssueReconcilerInput {
  cleanupWorkspace(record: RunningIssueRecord): Promise<unknown>;
  closeAttempt(record: RunningIssueRecord, decision: RunningIssueCloseDecision): Promise<unknown>;
  config: {
    configuredAssignee: string | null;
    leaseTtlMs: number;
    requiredLabels: readonly string[];
    retryBackoffMs: number;
    stallTimeoutMs: number;
  };
  loadRunning(): Promise<readonly RunningIssueRecord[]>;
  newId(): string;
  now(): string;
  observeIssue(issue: Issue, providerRevision: string): Promise<unknown>;
  renewLease(record: RunningIssueRecord, renewedAt: string, newExpiresAt: string): Promise<unknown>;
  safety: PersistenceSafetyController;
  stopWorker(record: RunningIssueRecord, reason: string): Promise<unknown>;
  tracker: TrackerAdapter;
}

export function createRunningIssueReconciler(input: RunningIssueReconcilerInput) {
  requirePositiveInteger(input.config.leaseTtlMs, "scheduler.invalid_lease_ttl");
  requirePositiveInteger(input.config.retryBackoffMs, "scheduler.invalid_retry_backoff");

  return async (): Promise<void> => {
    const records = await input.loadRunning();
    if (records.length === 0) return;
    const byAttempt = new Map(records.map((record) => [record.attemptId, record]));
    let pendingObservations: Array<{ issue: Issue; providerRevision: string }> = [];
    await reconcileRunningAttempts(records, input.config, {
      async cleanupWorkspace(attempt) {
        await input.cleanupWorkspace(requireRecord(byAttempt, attempt.attemptId));
      },
      async commitStop(attempt, decision) {
        const record = requireRecord(byAttempt, attempt.attemptId);
        await input.closeAttempt(record, closeDecision(input, decision));
      },
      async fetchObservations(issueIds) {
        const [issues, states] = await Promise.all([
          collectAllPages((cursor) => input.tracker.fetchIssuesByStates(TRACKER_STATES, cursor)),
          collectAllPages((cursor) => input.tracker.fetchStatesByIds(issueIds, cursor)),
        ]);
        const wanted = new Set(issueIds);
        const issueById = new Map(
          issues.filter((item) => wanted.has(item.id)).map((item) => [item.id, item]),
        );
        const revisionById = new Map(states.map((state) => [state.id, state.revision]));
        for (const issueId of issueIds) {
          if (!issueById.has(issueId) || !revisionById.has(issueId)) {
            throw new Error(`tracker.running_issue_missing:${issueId}`);
          }
        }
        pendingObservations = issueIds.map((issueId) => ({
          issue: issueById.get(issueId) as Issue,
          providerRevision: revisionById.get(issueId) as string,
        }));
        return new Map(
          issueIds.map((issueId) => {
            const issue = issueById.get(issueId) as Issue;
            return [
              issueId,
              { assigneeId: issue.assignee_id, labels: issue.labels, state: issue.state },
            ];
          }),
        );
      },
      now: () => parseTime(input.now(), "scheduler.invalid_now"),
      async persistObservations() {
        for (const observation of pendingObservations) {
          await input.observeIssue(observation.issue, observation.providerRevision);
        }
        pendingObservations = [];
      },
      async renewLease(attempt) {
        const record = requireRecord(byAttempt, attempt.attemptId);
        const renewedAt = input.now();
        const renewedAtMs = parseTime(renewedAt, "scheduler.invalid_now");
        const expectedMs = parseTime(record.expectedExpiresAt, "scheduler.invalid_expected_expiry");
        const newExpiresAt = new Date(
          Math.max(expectedMs + 1, renewedAtMs + input.config.leaseTtlMs),
        ).toISOString();
        await input.renewLease(record, renewedAt, newExpiresAt);
      },
      safety: input.safety,
      async stopWorker(attempt, reason) {
        await input.stopWorker(requireRecord(byAttempt, attempt.attemptId), reason);
      },
    });
  };
}

export function createPersistentRunningIssueReconciler(input: {
  allowlistedEnvironmentNames: readonly string[];
  beforeRemoveCommand: string | null;
  config: RunningIssueReconcilerInput["config"];
  database: OpenedDatabase["database"];
  hookTimeoutMs: number;
  killWaitMs: number;
  newId(): string;
  now(): string;
  onBeforeRemoveResult?: (result: Awaited<ReturnType<typeof runLinuxHook>>) => void;
  onRunningLoaded?: (records: readonly RunningIssueRecord[]) => void;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  terminateWaitMs: number;
  tracker: TrackerAdapter;
  workspaceRoot: string;
}) {
  return createRunningIssueReconciler({
    async cleanupWorkspace(record) {
      await removeTerminalWorkspace({
        assignedWorkspace: record.workspacePath,
        ...(input.beforeRemoveCommand
          ? {
              async beforeRemove(workspace: string) {
                const result = await runLinuxHook({
                  allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
                  command: input.beforeRemoveCommand as string,
                  kind: "before_remove",
                  sourceEnvironment: input.sourceEnvironment,
                  timeoutMs: input.hookTimeoutMs,
                  workspace,
                  workspaceRoot: input.workspaceRoot,
                });
                input.onBeforeRemoveResult?.(result);
              },
            }
          : {}),
        workspaceRoot: input.workspaceRoot,
      });
    },
    async closeAttempt(record, decision) {
      const nextClaim =
        decision.nextClaim === "release"
          ? ({ mode: "Released", reason: decision.reason } as const)
          : decision.nextClaim === "ready"
            ? ({ mode: "Ready", reason: decision.reason } as const)
            : ({
                dueAt: requireRetryDueAt(decision),
                mode: "RetryQueued",
                reason: decision.reason,
              } as const);
      await closeRunningAttemptForReconciliation(input.database, {
        attemptId: record.attemptId,
        endedAt: input.now(),
        failureClass: decision.failureClass,
        nextClaim,
        summary: decision.summary,
        terminalResultId: decision.terminalResultId,
      });
    },
    config: input.config,
    async loadRunning() {
      const records = await listRunningIssueAttempts(input.database);
      input.onRunningLoaded?.(records);
      return records;
    },
    newId: input.newId,
    now: input.now,
    observeIssue: (issue, providerRevision) =>
      observeIssue(input.database, {
        issue,
        observedAt: input.now(),
        providerRevision,
        transitionId: input.newId(),
      }),
    renewLease: (record, renewedAt, newExpiresAt) =>
      renewRunningClaim(input.database, {
        expectedExpiresAt: record.expectedExpiresAt,
        holder: record.holder,
        newExpiresAt,
        renewedAt,
        workRef: { id: record.issueId, kind: "issue" },
      }),
    safety: input.safety,
    stopWorker: (record) =>
      terminateLinuxProcessGroup({
        killWaitMs: input.killWaitMs,
        processGroupId: record.processGroupId,
        processId: record.processId,
        terminateWaitMs: input.terminateWaitMs,
      }),
    tracker: input.tracker,
  });
}

export function createPersistentRunningSystemJobReconciler(input: {
  config: Pick<
    RunningIssueReconcilerInput["config"],
    "leaseTtlMs" | "retryBackoffMs" | "stallTimeoutMs"
  >;
  database: OpenedDatabase["database"];
  killWaitMs: number;
  newId(): string;
  now(): string;
  onRunningLoaded?: (records: readonly RunningIssueRecord[]) => void;
  safety: PersistenceSafetyController;
  terminateWaitMs: number;
}) {
  return async (): Promise<void> => {
    const records = await listRunningSystemJobAttempts(input.database);
    input.onRunningLoaded?.(records);
    const now = input.now();
    const nowMs = parseTime(now, "scheduler.invalid_now");
    for (const record of records) {
      const stalled =
        nowMs - parseTime(record.lastEventAt, "scheduler.invalid_last_event") >=
        input.config.stallTimeoutMs;
      if (stalled) {
        await terminateLinuxProcessGroup({
          killWaitMs: input.killWaitMs,
          processGroupId: record.processGroupId,
          processId: record.processId,
          terminateWaitMs: input.terminateWaitMs,
        });
        await closeRunningAttemptForReconciliation(input.database, {
          attemptId: record.attemptId,
          endedAt: now,
          failureClass: "agent_process",
          nextClaim: {
            dueAt: new Date(nowMs + input.config.retryBackoffMs).toISOString(),
            mode: "RetryQueued",
            reason: "stall_timeout",
          },
          summary: "Repair SystemJob agent session stalled during execution",
          terminalResultId: input.newId(),
        });
        continue;
      }
      const expectedMs = parseTime(record.expectedExpiresAt, "scheduler.invalid_expected_expiry");
      await renewRunningClaim(input.database, {
        expectedExpiresAt: record.expectedExpiresAt,
        holder: record.holder,
        newExpiresAt: new Date(
          Math.max(expectedMs + 1, nowMs + input.config.leaseTtlMs),
        ).toISOString(),
        renewedAt: now,
        workRef: { id: record.issueId, kind: "system_job" },
      });
    }
  };
}

function closeDecision(
  input: RunningIssueReconcilerInput,
  decision: Extract<RunningReconciliationDecision, { action: "stop" }>,
): RunningIssueCloseDecision {
  const now = input.now();
  if (decision.nextClaim === "release") {
    return {
      failureClass: "task",
      nextClaim: "release",
      reason: decision.reason,
      retryDueAt: null,
      summary: "Tracker issue became terminal during execution",
      terminalResultId: input.newId(),
    };
  }
  if (decision.nextClaim === "retry") {
    return {
      failureClass: "agent_process",
      nextClaim: "retry",
      reason: decision.reason,
      retryDueAt: new Date(
        parseTime(now, "scheduler.invalid_now") + input.config.retryBackoffMs,
      ).toISOString(),
      summary: "Agent session stalled during execution",
      terminalResultId: input.newId(),
    };
  }
  return {
    failureClass: "task",
    nextClaim: "ready",
    reason: decision.reason,
    retryDueAt: null,
    summary: "Tracker lane or eligibility changed during execution",
    terminalResultId: input.newId(),
  };
}

function requireRecord(
  records: ReadonlyMap<string, RunningIssueRecord>,
  attemptId: string,
): RunningIssueRecord {
  const record = records.get(attemptId);
  if (!record) throw new Error(`scheduler.running_record_missing:${attemptId}`);
  return record;
}

function requirePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

function parseTime(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function requireRetryDueAt(decision: RunningIssueCloseDecision): string {
  if (decision.retryDueAt === null) throw new Error("scheduler.retry_due_at_missing");
  return decision.retryDueAt;
}
