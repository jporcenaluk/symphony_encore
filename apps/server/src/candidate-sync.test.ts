import type { Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import { describe, expect, it, vi } from "vitest";

import { syncTrackerCandidates } from "./candidate-sync.js";

const issue: Issue = {
  acceptance_criteria: ["Persist baseline"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "",
  id: "issue-1",
  identifier: "ORG-1",
  labels: ["ready"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "Todo",
  title: "Candidate",
  updated_at: "2026-07-13T10:00:00Z",
  url: "https://example.test/issues/1",
};

describe("tracker candidate synchronization", () => {
  it("pairs complete candidate pages with provider revisions before durable observation", async () => {
    const observed: string[] = [];
    const tracker = {
      createOrUpdateComment: vi.fn(),
      fetchCandidates: vi.fn(async (cursor: string | null) =>
        cursor === null
          ? { cursor: "candidate-2", hasMore: true, items: [] }
          : { cursor: null, hasMore: false, items: [issue] },
      ),
      fetchCommentsSince: vi.fn(),
      fetchIssuesByStates: vi.fn(),
      fetchStatesByIds: vi.fn(async () => ({
        cursor: null,
        hasMore: false,
        items: [{ id: "issue-1", revision: "revision-1", state: "Todo" }],
      })),
      updateIssueLane: vi.fn(),
    };
    const result = await syncTrackerCandidates({
      observeIssue: async (candidate, revision) => observed.push(`${candidate.id}:${revision}`),
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      tracker,
    });

    expect(result).toEqual([issue]);
    expect(observed).toEqual(["issue-1:revision-1"]);
    expect(tracker.fetchCandidates).toHaveBeenCalledTimes(2);
  });

  it("latches observation persistence failure", async () => {
    const stopAll = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopAll);
    await expect(
      syncTrackerCandidates({
        observeIssue: async () => {
          throw new Error("sqlite.disk_full");
        },
        safety,
        tracker: {
          createOrUpdateComment: vi.fn(),
          fetchCandidates: vi.fn(async () => ({ cursor: null, hasMore: false, items: [issue] })),
          fetchCommentsSince: vi.fn(),
          fetchIssuesByStates: vi.fn(),
          fetchStatesByIds: vi.fn(async () => ({
            cursor: null,
            hasMore: false,
            items: [{ id: "issue-1", revision: "revision-1", state: "Todo" }],
          })),
          updateIssueLane: vi.fn(),
        },
      }),
    ).rejects.toThrow("sqlite.disk_full");
    expect(stopAll).toHaveBeenCalledOnce();
    expect(safety.canDispatch()).toBe(false);
  });
});
