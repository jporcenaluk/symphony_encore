export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface PlannedAcceptanceCriterion {
  criterionId: string;
  criterionText: string;
  plannedEvidence: string;
}

export interface PlanCandidate {
  acceptanceCriteria: readonly PlannedAcceptanceCriterion[];
  approach: string;
  estimatedChangedLines: number;
  estimatedFiles: number;
  proposedPaths: readonly string[];
  riskFacts: readonly string[];
  verificationCommands: readonly string[];
}

export type PlanValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "plan.issue_not_ready"
        | "plan.criteria_incomplete"
        | "plan.verification_missing"
        | "plan.size_inconsistent"
        | "plan.invalid_value";
      details?: readonly string[];
    };

export function validatePlan(
  expectedCriteria: readonly AcceptanceCriterion[],
  plan: PlanCandidate,
): PlanValidation {
  if (expectedCriteria.length === 0) return { ok: false, reason: "plan.issue_not_ready" };

  const invalidCriteria = expectedCriteria
    .filter((expected) => {
      const matches = plan.acceptanceCriteria.filter(
        (candidate) =>
          candidate.criterionId === expected.id &&
          candidate.criterionText === expected.text &&
          candidate.plannedEvidence.trim().length > 0,
      );
      return matches.length !== 1;
    })
    .map((criterion) => criterion.id);
  const expectedIds = new Set(expectedCriteria.map((criterion) => criterion.id));
  const unexpectedCriteria = plan.acceptanceCriteria
    .filter((criterion) => !expectedIds.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId);
  const criteriaProblems = [...invalidCriteria, ...unexpectedCriteria];
  if (criteriaProblems.length > 0) {
    return {
      ok: false,
      reason: "plan.criteria_incomplete",
      details: [...new Set(criteriaProblems)],
    };
  }

  if (
    plan.verificationCommands.length === 0 ||
    plan.verificationCommands.some((command) => command.trim().length === 0)
  ) {
    return { ok: false, reason: "plan.verification_missing" };
  }

  const uniquePaths = new Set(plan.proposedPaths);
  if (
    plan.estimatedFiles !== plan.proposedPaths.length ||
    uniquePaths.size !== plan.proposedPaths.length ||
    plan.estimatedFiles <= 0 ||
    !Number.isInteger(plan.estimatedFiles) ||
    plan.estimatedChangedLines < 0 ||
    !Number.isInteger(plan.estimatedChangedLines)
  ) {
    return { ok: false, reason: "plan.size_inconsistent" };
  }

  if (
    plan.approach.trim().length === 0 ||
    plan.proposedPaths.some((path) => path.trim().length === 0) ||
    plan.riskFacts.some((fact) => fact.trim().length === 0)
  ) {
    return { ok: false, reason: "plan.invalid_value" };
  }
  return { ok: true };
}
