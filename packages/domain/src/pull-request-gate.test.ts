import { describe, expect, it } from "vitest";

import { evaluatePullRequestGate } from "./pull-request-gate.js";

const snapshot = {
  baseRef: "main",
  checks: [
    {
      conclusion: "success",
      name: "ci / required",
      requiredSource: "protection" as const,
      status: "completed",
      targetSha: "def5678",
    },
  ],
  headSha: "def5678",
  isDraft: false,
  mergeable: true,
  observedBaseSha: "abc1234",
  prState: "open" as const,
  reviewDecision: "none" as const,
  unresolvedThreads: [],
};

describe("pull-request hygiene policy", () => {
  const requiredCheck = snapshot.checks[0];
  if (!requiredCheck) throw new Error("missing pull-request gate fixture check");
  it("allows one complete current-head snapshot", () => {
    expect(
      evaluatePullRequestGate(snapshot, {
        acceptedCheckConclusions: ["success", "neutral", "skipped"],
        expectedBaseRef: "main",
        expectedBaseSha: "abc1234",
        expectedHeadSha: "def5678",
        quietPeriodSatisfied: true,
        requiredChecks: ["ci / required"],
      }),
    ).toEqual({ decision: "allow" });
  });

  it.each([
    {
      expected: { decision: "deny", reason: "pull_request.closed" },
      value: { ...snapshot, prState: "closed" as const },
    },
    {
      expected: { decision: "deny", reason: "pull_request.draft" },
      value: { ...snapshot, isDraft: true },
    },
    {
      expected: { decision: "wait", reason: "pull_request.mergeability_pending" },
      value: { ...snapshot, mergeable: null },
    },
    {
      expected: { decision: "deny", reason: "pull_request.not_mergeable" },
      value: { ...snapshot, mergeable: false },
    },
    {
      expected: { decision: "update_required", reason: "pull_request.base_advanced" },
      value: { ...snapshot, observedBaseSha: "aaaaaaa" },
    },
    {
      expected: { decision: "deny", reason: "pull_request.head_mismatch" },
      value: { ...snapshot, headSha: "eeeeeee" },
    },
    {
      expected: { decision: "deny", reason: "pull_request.changes_requested" },
      value: { ...snapshot, reviewDecision: "changes_requested" as const },
    },
    {
      expected: { decision: "deny", reason: "pull_request.thread_unresolved:thread-1" },
      value: {
        ...snapshot,
        unresolvedThreads: [{ commitSha: "def5678", id: "thread-1", isOutdated: false }],
      },
    },
  ])("returns the typed $expected.reason decision", ({ expected, value }) => {
    expect(
      evaluatePullRequestGate(value, {
        acceptedCheckConclusions: ["success", "neutral", "skipped"],
        expectedBaseRef: "main",
        expectedBaseSha: "abc1234",
        expectedHeadSha: "def5678",
        quietPeriodSatisfied: true,
        requiredChecks: ["ci / required"],
      }),
    ).toEqual(expected);
  });

  it("waits for missing, pending, and quiet-period evidence but denies stale or failed checks", () => {
    const options = {
      acceptedCheckConclusions: ["success"],
      expectedBaseRef: "main",
      expectedBaseSha: "abc1234",
      expectedHeadSha: "def5678",
      quietPeriodSatisfied: true,
      requiredChecks: ["ci / required"],
    };
    expect(evaluatePullRequestGate({ ...snapshot, checks: [] }, options)).toEqual({
      decision: "wait",
      reason: "pull_request.check_missing:ci / required",
    });
    expect(
      evaluatePullRequestGate(
        {
          ...snapshot,
          checks: [{ ...requiredCheck, conclusion: null, status: "in_progress" }],
        },
        options,
      ),
    ).toEqual({ decision: "wait", reason: "pull_request.check_pending:ci / required" });
    expect(
      evaluatePullRequestGate(
        {
          ...snapshot,
          checks: [{ ...requiredCheck, targetSha: "eeeeeee" }],
        },
        options,
      ),
    ).toEqual({ decision: "deny", reason: "pull_request.check_stale:ci / required" });
    expect(
      evaluatePullRequestGate(
        {
          ...snapshot,
          checks: [{ ...requiredCheck, conclusion: "failure" }],
        },
        options,
      ),
    ).toEqual({ decision: "deny", reason: "pull_request.check_failed:ci / required:failure" });
    expect(evaluatePullRequestGate(snapshot, { ...options, quietPeriodSatisfied: false })).toEqual({
      decision: "wait",
      reason: "pull_request.quiet_period_pending",
    });
  });
});
