import { describe, expect, it } from "vitest";

import { decideReviewSet, type ReviewRecordSummary } from "./review-policy.js";

const integrativeRecord: ReviewRecordSummary = {
  decision: "approve",
  findings: [],
  reviewer: "integrative_review",
  targetSha: "abcdef1",
};
const passingInput = {
  guardDecisions: [{ result: "allow" as const, targetSha: "abcdef1" }],
  records: [integrativeRecord],
  requiredReviewers: ["integrative_review"],
  targetSha: "abcdef1",
  verification: { passed: true, targetSha: "abcdef1" },
};

describe("ordinary ReviewSet policy", () => {
  it("approves only a complete current-revision reviewer set", () => {
    expect(decideReviewSet(passingInput)).toEqual({ decision: "approve" });
    expect(decideReviewSet({ ...passingInput, records: [] })).toEqual({
      decision: "blocked",
      reason: "review.required_reviewer_missing",
    });
    expect(
      decideReviewSet({
        ...passingInput,
        records: [{ ...integrativeRecord, targetSha: "old-sha" }],
      }),
    ).toEqual({ decision: "blocked", reason: "review.stale_record" });
  });

  it("allows trivial work to approve with no model reviewers", () => {
    expect(decideReviewSet({ ...passingInput, records: [], requiredReviewers: [] })).toEqual({
      decision: "approve",
    });
  });

  it("requires current passing verification and allowing guards", () => {
    expect(
      decideReviewSet({
        ...passingInput,
        verification: { passed: true, targetSha: "old-sha" },
      }),
    ).toEqual({ decision: "blocked", reason: "review.verification_not_current" });
    expect(
      decideReviewSet({
        ...passingInput,
        guardDecisions: [{ result: "deny", targetSha: "abcdef1" }],
      }),
    ).toEqual({ decision: "blocked", reason: "review.guard_denied" });
  });

  it("retains one uncontested blocker without voting", () => {
    expect(
      decideReviewSet({
        ...passingInput,
        records: [
          integrativeRecord,
          {
            decision: "needs_rework",
            findings: [{ blocking: true, id: "finding-1" }],
            reviewer: "systems_security",
            targetSha: "abcdef1",
          },
        ],
        requiredReviewers: ["integrative_review", "systems_security"],
      }),
    ).toEqual({
      decision: "needs_rework",
      unresolvedBlockingFindingIds: ["finding-1"],
    });
  });
});
