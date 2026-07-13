import type { Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import { describe, expect, it, vi } from "vitest";

import { createRunningIssueReconciler } from "./running-issue-reconciler.js";

const issue: Issue = {
  acceptance_criteria: ["Done is terminal"],
  assignee_id: "agent-1",
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "",
  id: "issue-1",
  identifier: "ORG-1",
  labels: ["ready"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "Done",
  title: "Terminal issue",
  updated_at: "2026-07-13T10:01:00Z",
  url: "https://example.test/issues/1",
};

describe("production running issue reconciliation", () => {
  it("persists complete tracker observation before stop, closure, and terminal cleanup", async () => {
    const calls: string[] = [];
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(async (_states: readonly string[], cursor: string | null) =>
        cursor === null
          ? { cursor: "issues-2", hasMore: true, items: [] }
          : { cursor: null, hasMore: false, items: [issue] },
      ),
      fetchStatesByIds: vi.fn(async (_ids: readonly string[], cursor: string | null) =>
        cursor === null
          ? { cursor: "states-2", hasMore: true, items: [] }
          : {
              cursor: null,
              hasMore: false,
              items: [{ id: "issue-1", revision: "revision-terminal", state: "Done" }],
            },
      ),
      updateIssueLane: vi.fn(),
    };
    const reconcile = createRunningIssueReconciler({
      cleanupWorkspace: async () => calls.push("cleanup"),
      closeAttempt: async (_record, decision) => calls.push(`close:${decision.nextClaim}`),
      config: {
        configuredAssignee: "agent-1",
        leaseTtlMs: 120_000,
        requiredLabels: ["ready"],
        retryBackoffMs: 30_000,
        stallTimeoutMs: 300_000,
      },
      loadRunning: async () => [
        {
          attemptId: "attempt-1",
          attemptLane: "In Progress",
          expectedExpiresAt: "2026-07-13T10:02:00Z",
          holder: "run-1",
          issueId: "issue-1",
          lastEventAt: "2026-07-13T10:00:30Z",
          processGroupId: 1000,
          processId: 1001,
          workspacePath: "/work/issue-1",
        },
      ],
      newId: () => "result-1",
      now: () => "2026-07-13T10:01:00Z",
      observeIssue: async (_issue, revision) => calls.push(`observe:${revision}`),
      renewLease: vi.fn(),
      safety: new PersistenceSafetyController(async () => {
        calls.push("stop-all");
      }),
      stopWorker: async () => calls.push("stop"),
      tracker,
    });

    await reconcile();

    expect(calls).toEqual(["observe:revision-terminal", "stop", "close:release", "cleanup"]);
    expect(tracker.fetchIssuesByStates).toHaveBeenCalledTimes(2);
    expect(tracker.fetchStatesByIds).toHaveBeenCalledTimes(2);
  });

  it("renews instead of stopping when complete tracker refresh fails", async () => {
    const renewLease = vi.fn(async () => undefined);
    const stopWorker = vi.fn();
    const reconcile = createRunningIssueReconciler({
      cleanupWorkspace: vi.fn(),
      closeAttempt: vi.fn(),
      config: {
        configuredAssignee: null,
        leaseTtlMs: 120_000,
        requiredLabels: [],
        retryBackoffMs: 30_000,
        stallTimeoutMs: 300_000,
      },
      loadRunning: async () => [
        {
          attemptId: "attempt-1",
          attemptLane: "In Progress",
          expectedExpiresAt: "2026-07-13T10:02:00Z",
          holder: "run-1",
          issueId: "issue-1",
          lastEventAt: "2026-07-13T10:00:30Z",
          processGroupId: 1000,
          processId: 1001,
          workspacePath: "/work/issue-1",
        },
      ],
      newId: () => "result-1",
      now: () => "2026-07-13T10:01:00Z",
      observeIssue: vi.fn(),
      renewLease,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      stopWorker,
      tracker: {
        createOrUpdateComment: vi.fn(),
        fetchCandidates: vi.fn(),
        fetchCommentsSince: vi.fn(),
        fetchIssuesByStates: vi.fn(async () => {
          throw new Error("tracker.unavailable");
        }),
        fetchStatesByIds: vi.fn(),
        updateIssueLane: vi.fn(),
      },
    });

    await reconcile();
    expect(renewLease).toHaveBeenCalledOnce();
    expect(stopWorker).not.toHaveBeenCalled();
  });
});
