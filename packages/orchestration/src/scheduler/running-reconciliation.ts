import type { PersistenceSafetyController } from "./persistence-safety.js";

const TERMINAL_TRACKER_STATES = new Set(["done", "closed", "cancelled", "duplicate"]);

export interface RunningAttemptSnapshot {
  attemptId: string;
  attemptLane: string;
  issueId: string;
  lastEventAt: string;
  workspacePath: string;
}

export interface RunningIssueObservation {
  assigneeId: string | null;
  labels: readonly string[];
  state: string;
}

export interface RunningReconciliationConfig {
  configuredAssignee: string | null;
  requiredLabels: readonly string[];
  stallTimeoutMs: number;
}

export type RunningReconciliationDecision =
  | { action: "continue"; reason: "running.healthy" }
  | {
      action: "stop";
      cleanupWorkspace: boolean;
      nextClaim: "ready" | "release" | "retry";
      reason:
        | "agent.stalled"
        | "eligibility.assignee_lost"
        | "eligibility.required_label_lost"
        | "tracker.lane_drift"
        | "tracker.terminal";
    };

export interface RunningReconciliationPorts {
  cleanupWorkspace(attempt: RunningAttemptSnapshot): Promise<unknown>;
  commitStop(
    attempt: RunningAttemptSnapshot,
    decision: Extract<RunningReconciliationDecision, { action: "stop" }>,
  ): Promise<unknown>;
  fetchObservations(
    issueIds: readonly string[],
  ): Promise<ReadonlyMap<string, RunningIssueObservation>>;
  now(): number;
  persistObservations?(
    observations: ReadonlyMap<string, RunningIssueObservation>,
  ): Promise<unknown>;
  renewLease(attempt: RunningAttemptSnapshot): Promise<unknown>;
  safety: PersistenceSafetyController;
  stopWorker(attempt: RunningAttemptSnapshot, reason: string): Promise<unknown>;
}

export function planRunningReconciliation(input: {
  attempt: RunningAttemptSnapshot;
  config: RunningReconciliationConfig;
  now: number;
  observation: RunningIssueObservation;
}): RunningReconciliationDecision {
  const state = input.observation.state.trim().toLocaleLowerCase("en-US");
  if (TERMINAL_TRACKER_STATES.has(state)) {
    return {
      action: "stop",
      cleanupWorkspace: true,
      nextClaim: "release",
      reason: "tracker.terminal",
    };
  }
  if (input.observation.state !== input.attempt.attemptLane) {
    return {
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "ready",
      reason: "tracker.lane_drift",
    };
  }
  if (
    input.config.configuredAssignee !== null &&
    input.observation.assigneeId !== input.config.configuredAssignee
  ) {
    return {
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "ready",
      reason: "eligibility.assignee_lost",
    };
  }
  const requiredLabels = normalizeRequiredLabels(input.config.requiredLabels);
  const observedLabels = new Set(
    input.observation.labels.map((label) => label.toLocaleLowerCase("en-US")),
  );
  if (requiredLabels.some((label) => !observedLabels.has(label))) {
    return {
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "ready",
      reason: "eligibility.required_label_lost",
    };
  }

  if (!Number.isSafeInteger(input.config.stallTimeoutMs)) {
    throw new Error("configuration.invalid_stall_timeout");
  }
  if (input.config.stallTimeoutMs <= 0) {
    return { action: "continue", reason: "running.healthy" };
  }
  const lastEventAt = Date.parse(input.attempt.lastEventAt);
  if (!Number.isFinite(lastEventAt)) throw new Error("attempt.invalid_last_event_at");
  if (input.now - lastEventAt > input.config.stallTimeoutMs) {
    return {
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "retry",
      reason: "agent.stalled",
    };
  }
  return { action: "continue", reason: "running.healthy" };
}

export async function reconcileRunningAttempts(
  attempts: readonly RunningAttemptSnapshot[],
  config: RunningReconciliationConfig,
  ports: RunningReconciliationPorts,
): Promise<void> {
  let observations: ReadonlyMap<string, RunningIssueObservation> | null = null;
  try {
    observations = await ports.fetchObservations(attempts.map((attempt) => attempt.issueId));
  } catch {
    // Tracker state refresh is advisory: a failure must not terminate a healthy worker.
  }

  if (observations !== null && ports.persistObservations) {
    try {
      await ports.persistObservations(observations);
    } catch (error) {
      const failure = asError(error);
      await ports.safety.recordFailure(failure);
      throw failure;
    }
  }

  const now = ports.now();
  for (const attempt of attempts) {
    const observation = observations?.get(attempt.issueId);
    if (observation === undefined) {
      await renewLeaseOrLatch(attempt, ports);
      continue;
    }
    const decision = planRunningReconciliation({ attempt, config, now, observation });
    if (decision.action === "continue") {
      await renewLeaseOrLatch(attempt, ports);
      continue;
    }

    await ports.stopWorker(attempt, decision.reason);
    try {
      await ports.commitStop(attempt, decision);
    } catch (error) {
      const failure = asError(error);
      await ports.safety.recordFailure(failure);
      throw failure;
    }
    if (decision.cleanupWorkspace) await ports.cleanupWorkspace(attempt);
  }
}

function normalizeRequiredLabels(labels: readonly string[]): string[] {
  return labels.map((label) => {
    const normalized = label.trim().toLocaleLowerCase("en-US");
    if (!normalized) throw new Error("configuration.blank_required_label");
    return normalized;
  });
}

async function renewLeaseOrLatch(
  attempt: RunningAttemptSnapshot,
  ports: RunningReconciliationPorts,
): Promise<void> {
  try {
    await ports.renewLease(attempt);
  } catch (error) {
    const failure = asError(error);
    await ports.safety.recordFailure(failure);
    throw failure;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
