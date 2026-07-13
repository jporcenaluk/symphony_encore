export type ReviewDecision = "approve" | "needs_rework" | "needs_human" | "blocked";

export interface ReviewFindingSummary {
  blocking: boolean;
  id: string;
}

export interface ReviewRecordSummary {
  decision: ReviewDecision;
  findings: readonly ReviewFindingSummary[];
  reviewer: string;
  targetSha: string;
}

export interface GuardDecisionSummary {
  result: "allow" | "deny";
  targetSha: string;
}

export interface ReviewSetInput {
  guardDecisions: readonly GuardDecisionSummary[];
  records: readonly ReviewRecordSummary[];
  requiredReviewers: readonly string[];
  targetSha: string;
  verification: { passed: boolean; targetSha: string };
}

export type ReviewSetDecision =
  | { decision: "approve" }
  | { decision: "needs_rework"; unresolvedBlockingFindingIds: readonly string[] }
  | { decision: "needs_human"; unresolvedBlockingFindingIds: readonly string[] }
  | {
      decision: "blocked";
      reason:
        | "review.verification_not_current"
        | "review.verification_failed"
        | "review.stale_guard"
        | "review.guard_denied"
        | "review.stale_record"
        | "review.required_reviewer_missing"
        | "review.required_reviewer_duplicate"
        | "review.reviewer_blocked";
    };

export function decideReviewSet(input: ReviewSetInput): ReviewSetDecision {
  if (input.verification.targetSha !== input.targetSha) {
    return { decision: "blocked", reason: "review.verification_not_current" };
  }
  if (!input.verification.passed) {
    return { decision: "blocked", reason: "review.verification_failed" };
  }
  if (input.guardDecisions.some((guard) => guard.targetSha !== input.targetSha)) {
    return { decision: "blocked", reason: "review.stale_guard" };
  }
  if (input.guardDecisions.some((guard) => guard.result === "deny")) {
    return { decision: "blocked", reason: "review.guard_denied" };
  }
  if (input.records.some((record) => record.targetSha !== input.targetSha)) {
    return { decision: "blocked", reason: "review.stale_record" };
  }

  for (const reviewer of input.requiredReviewers) {
    const count = input.records.filter((record) => record.reviewer === reviewer).length;
    if (count === 0) {
      return { decision: "blocked", reason: "review.required_reviewer_missing" };
    }
    if (count > 1) {
      return { decision: "blocked", reason: "review.required_reviewer_duplicate" };
    }
  }

  const unresolvedBlockingFindingIds = [
    ...new Set(
      input.records.flatMap((record) =>
        record.findings.filter((finding) => finding.blocking).map((finding) => finding.id),
      ),
    ),
  ];
  if (input.records.some((record) => record.decision === "blocked")) {
    return { decision: "blocked", reason: "review.reviewer_blocked" };
  }
  if (input.records.some((record) => record.decision === "needs_human")) {
    return { decision: "needs_human", unresolvedBlockingFindingIds };
  }
  if (
    unresolvedBlockingFindingIds.length > 0 ||
    input.records.some((record) => record.decision === "needs_rework")
  ) {
    return { decision: "needs_rework", unresolvedBlockingFindingIds };
  }
  return { decision: "approve" };
}
