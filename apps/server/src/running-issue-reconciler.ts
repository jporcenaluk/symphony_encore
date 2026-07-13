import { collectAllPages, type TrackerAdapter } from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import {
  type PersistenceSafetyController,
  type RunningAttemptSnapshot,
  type RunningReconciliationDecision,
  reconcileRunningAttempts,
} from "@symphony/orchestration";

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
    const byAttempt = new Map(records.map((record) => [record.attemptId, record]));
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
        for (const issueId of issueIds) {
          await input.observeIssue(
            issueById.get(issueId) as Issue,
            revisionById.get(issueId) as string,
          );
        }
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
