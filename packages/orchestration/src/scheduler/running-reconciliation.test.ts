import { describe, expect, it, vi } from "vitest";

import { PersistenceSafetyController } from "./persistence-safety.js";
import {
  planRunningReconciliation,
  type RunningAttemptSnapshot,
  type RunningIssueObservation,
  reconcileRunningAttempts,
} from "./running-reconciliation.js";

const attempt: RunningAttemptSnapshot = {
  attemptId: "attempt-1",
  attemptLane: "In Progress",
  issueId: "issue-1",
  lastEventAt: "2026-07-13T10:00:00.000Z",
  workspacePath: "/work/issue-1",
};

const observation: RunningIssueObservation = {
  assigneeId: "agent-1",
  labels: ["ready", "backend"],
  state: "In Progress",
};

const config = {
  configuredAssignee: "agent-1",
  requiredLabels: ["ready"],
  stallTimeoutMs: 300_000,
};

describe("running reconciliation planning", () => {
  it("stops terminal work with cleanup and releases its claim", () => {
    expect(
      planRunningReconciliation({
        attempt,
        config,
        now: Date.parse("2026-07-13T10:01:00.000Z"),
        observation: { ...observation, state: "Cancelled" },
      }),
    ).toEqual({
      action: "stop",
      cleanupWorkspace: true,
      nextClaim: "release",
      reason: "tracker.terminal",
    });
  });

  it.each([
    ["lane drift", { ...observation, state: "Review" }, "tracker.lane_drift"],
    ["assignee loss", { ...observation, assigneeId: "someone-else" }, "eligibility.assignee_lost"],
    [
      "required-label loss",
      { ...observation, labels: ["backend"] },
      "eligibility.required_label_lost",
    ],
  ] as const)("stops on %s without cleaning the workspace", (_name, observed, reason) => {
    expect(
      planRunningReconciliation({
        attempt,
        config,
        now: Date.parse("2026-07-13T10:01:00.000Z"),
        observation: observed,
      }),
    ).toEqual({
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "ready",
      reason,
    });
  });

  it("kills and retries a stalled attempt without cleaning its workspace", () => {
    expect(
      planRunningReconciliation({
        attempt,
        config,
        now: Date.parse("2026-07-13T10:05:00.001Z"),
        observation,
      }),
    ).toEqual({
      action: "stop",
      cleanupWorkspace: false,
      nextClaim: "retry",
      reason: "agent.stalled",
    });
  });

  it("keeps a healthy attempt running at the exact stall boundary", () => {
    expect(
      planRunningReconciliation({
        attempt,
        config,
        now: Date.parse("2026-07-13T10:05:00.000Z"),
        observation,
      }),
    ).toEqual({ action: "continue", reason: "running.healthy" });
  });

  it("disables stall detection when the configured timeout is non-positive", () => {
    expect(
      planRunningReconciliation({
        attempt,
        config: { ...config, stallTimeoutMs: 0 },
        now: Date.parse("2026-07-13T11:00:00.000Z"),
        observation,
      }),
    ).toEqual({ action: "continue", reason: "running.healthy" });
  });
});

describe("running reconciliation execution", () => {
  it("commits a terminal stop before workspace cleanup", async () => {
    const calls: string[] = [];
    const safety = new PersistenceSafetyController(async () => {
      calls.push("stop-all");
    });

    await reconcileRunningAttempts([attempt], config, {
      cleanupWorkspace: async () => calls.push("cleanup"),
      commitStop: async (_attempt, decision) => calls.push(`commit:${decision.nextClaim}`),
      fetchObservations: async () =>
        new Map([[attempt.issueId, { ...observation, state: "Done" }]]),
      now: () => Date.parse("2026-07-13T10:01:00.000Z"),
      renewLease: async () => calls.push("renew"),
      safety,
      stopWorker: async (_attempt, reason) => calls.push(`stop:${reason}`),
    });

    expect(calls).toEqual(["stop:tracker.terminal", "commit:release", "cleanup"]);
  });

  it("keeps workers running and renews leases when tracker refresh fails", async () => {
    const stopWorker = vi.fn();
    const renewLease = vi.fn(async () => undefined);

    await reconcileRunningAttempts([attempt], config, {
      cleanupWorkspace: vi.fn(),
      commitStop: vi.fn(),
      fetchObservations: async () => {
        throw new Error("tracker.unavailable");
      },
      now: () => Date.parse("2026-07-13T10:06:00.000Z"),
      renewLease,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      stopWorker,
    });

    expect(stopWorker).not.toHaveBeenCalled();
    expect(renewLease).toHaveBeenCalledWith(attempt);
  });

  it("latches a durable commit failure, stops all workers, and never cleans", async () => {
    const stopAll = vi.fn(async () => undefined);
    const cleanupWorkspace = vi.fn();
    const safety = new PersistenceSafetyController(stopAll);

    await expect(
      reconcileRunningAttempts([attempt], config, {
        cleanupWorkspace,
        commitStop: async () => {
          throw new Error("sqlite.disk_full");
        },
        fetchObservations: async () =>
          new Map([[attempt.issueId, { ...observation, state: "Done" }]]),
        now: () => Date.parse("2026-07-13T10:01:00.000Z"),
        renewLease: vi.fn(),
        safety,
        stopWorker: async () => undefined,
      }),
    ).rejects.toThrow("sqlite.disk_full");

    expect(stopAll).toHaveBeenCalledOnce();
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(safety.canDispatch()).toBe(false);
  });

  it("latches lease-renewal failure and stops all workers", async () => {
    const stopAll = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopAll);

    await expect(
      reconcileRunningAttempts([attempt], config, {
        cleanupWorkspace: vi.fn(),
        commitStop: vi.fn(),
        fetchObservations: async () => new Map([[attempt.issueId, observation]]),
        now: () => Date.parse("2026-07-13T10:01:00.000Z"),
        renewLease: async () => {
          throw new Error("claim.lease_not_renewable");
        },
        safety,
        stopWorker: vi.fn(),
      }),
    ).rejects.toThrow("claim.lease_not_renewable");

    expect(stopAll).toHaveBeenCalledOnce();
    expect(safety.canDispatch()).toBe(false);
  });
});
