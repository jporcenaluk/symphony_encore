import type { Issue } from "@symphony/contracts";
import { describe, expect, it, vi } from "vitest";

import { runPollTick, type SchedulerConfigValidation } from "./poll-tick.js";

function issue(id: string, priority: number | null): Issue {
  return {
    acceptance_criteria: ["works"],
    assignee_id: "agent-1",
    blocked_by: [],
    created_at: `2026-07-13T10:00:0${id}Z`,
    description: "Description",
    id,
    identifier: `ISSUE-${id}`,
    labels: ["ready"],
    priority,
    repo_name: "repo",
    repo_owner: "owner",
    state: "Todo",
    title: "Title",
    updated_at: "2026-07-13T10:00:00Z",
    url: `https://example.test/issues/${id}`,
  };
}

function validConfig(): SchedulerConfigValidation {
  return {
    config: { assignee: "agent-1", maxConcurrent: 2, requiredLabels: ["ready"] },
    ok: true,
  };
}

describe("ordered poll tick", () => {
  it("reconciles before dispatch, consumes only successful slots, then checks learning and fleet budgets", async () => {
    const calls: string[] = [];
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce("claim_conflict")
      .mockResolvedValueOnce("dispatched");

    const result = await runPollTick({
      advanceMergeQueue: async () => calls.push("merge"),
      checkLearningAndFleetBudgets: async () => calls.push("learning"),
      dispatch: async (candidate) => {
        calls.push(`dispatch:${candidate.id}`);
        return dispatch(candidate);
      },
      fetchCandidates: async () => {
        calls.push("fetch");
        return [issue("3", 3), issue("1", 1), issue("2", 2)];
      },
      isClaimed: async () => false,
      preflight: async (candidate) => {
        calls.push(`preflight:${candidate.id}`);
        return true;
      },
      reconcileAwaitingHuman: async () => calls.push("human"),
      reconcileRunning: async () => calls.push("running"),
      runningSlots: async () => 1,
      validateConfig: async () => {
        calls.push("config");
        return validConfig();
      },
    });

    expect(calls).toEqual([
      "running",
      "human",
      "merge",
      "config",
      "fetch",
      "preflight:1",
      "dispatch:1",
      "preflight:2",
      "dispatch:2",
      "learning",
    ]);
    expect(result).toEqual({ dispatched: ["2"], skippedDispatch: false });
  });

  it("keeps reconciliation and learning active but skips all dispatch work on invalid config", async () => {
    const calls: string[] = [];
    const result = await runPollTick({
      advanceMergeQueue: async () => calls.push("merge"),
      checkLearningAndFleetBudgets: async () => calls.push("learning"),
      dispatch: async () => {
        calls.push("dispatch");
        return "dispatched";
      },
      fetchCandidates: async () => {
        calls.push("fetch");
        return [];
      },
      isClaimed: async () => false,
      preflight: async () => true,
      reconcileAwaitingHuman: async () => calls.push("human"),
      reconcileRunning: async () => calls.push("running"),
      runningSlots: async () => 0,
      validateConfig: async () => {
        calls.push("config");
        return { errors: ["invalid"], ok: false };
      },
    });

    expect(calls).toEqual(["running", "human", "merge", "config", "learning"]);
    expect(result).toEqual({ dispatched: [], skippedDispatch: true });
  });
});
