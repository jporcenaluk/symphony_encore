import path from "node:path";

import type { Plan } from "@symphony/contracts";
import {
  type AuthoritativeClassification,
  classifyAuthoritatively,
  type ProvisionalClassification,
} from "@symphony/domain";

export interface ImplementationPlanGateInput {
  acceptanceCriteria: readonly string[];
  plan: Plan;
}

export interface ImplementationPlanGateResult {
  accepted: boolean;
  objections: readonly string[];
}

export interface ImplementationPlanClassificationInput {
  plan: Plan;
  provisional: ProvisionalClassification;
  riskPathPatterns: readonly string[];
  trivialMaxChangedLines: number;
  trivialPathPatterns: readonly string[];
}

export function classifyImplementationPlan(
  input: ImplementationPlanClassificationInput,
): AuthoritativeClassification {
  const riskFacts = input.riskPathPatterns.flatMap((pattern) =>
    input.plan.proposed_paths.some((candidate) => matchesPathPattern(candidate, pattern))
      ? [`risk.configured_path:${pattern}`]
      : [],
  );
  const everyPathMatchesTrivialPattern =
    input.plan.proposed_paths.length > 0 &&
    input.plan.proposed_paths.every((candidate) =>
      input.trivialPathPatterns.some((pattern) => matchesPathPattern(candidate, pattern)),
    );
  return classifyAuthoritatively(
    input.provisional,
    {
      acceptanceCriteriaPresent: input.plan.acceptance_criteria.length > 0,
      changedLines: input.plan.estimated_changed_lines,
      everyPathMatchesTrivialPattern,
      riskFacts,
      standardFacts: [],
    },
    {
      trivialMaxChangedLines: input.trivialMaxChangedLines,
      trivialPatternsConfigured: input.trivialPathPatterns.length > 0,
    },
  );
}

export function validateImplementationPlan(
  input: ImplementationPlanGateInput,
): ImplementationPlanGateResult {
  const objections: string[] = [];
  validateAcceptanceCoverage(input, objections);
  validatePathsAndEstimates(input.plan, objections);
  return { accepted: objections.length === 0, objections };
}

function validateAcceptanceCoverage(
  input: ImplementationPlanGateInput,
  objections: string[],
): void {
  const expected = new Set(input.acceptanceCriteria);
  const criterionIds = new Set<string>();
  const covered = new Set<string>();
  for (const criterion of input.plan.acceptance_criteria) {
    if (criterionIds.has(criterion.criterion_id)) {
      objections.push(`plan.acceptance_criterion_id_duplicate:${criterion.criterion_id}`);
    }
    criterionIds.add(criterion.criterion_id);
    if (covered.has(criterion.criterion_text)) {
      objections.push(`plan.acceptance_criterion_duplicate:${criterion.criterion_text}`);
    }
    covered.add(criterion.criterion_text);
    if (!expected.has(criterion.criterion_text)) {
      objections.push(`plan.acceptance_criterion_unknown:${criterion.criterion_text}`);
    }
  }
  for (const criterion of input.acceptanceCriteria) {
    if (!covered.has(criterion)) {
      objections.push(`plan.acceptance_criterion_missing:${criterion}`);
    }
  }
}

function validatePathsAndEstimates(plan: Plan, objections: string[]): void {
  const paths = new Set<string>();
  for (const proposedPath of plan.proposed_paths) {
    if (paths.has(proposedPath)) objections.push(`plan.path_duplicate:${proposedPath}`);
    paths.add(proposedPath);
    if (!isCanonicalRepositoryPath(proposedPath)) {
      objections.push(`plan.path_invalid:${proposedPath}`);
    }
  }
  if (plan.estimated_files !== plan.proposed_paths.length) {
    objections.push(
      `plan.estimated_files_mismatch:${plan.estimated_files}:${plan.proposed_paths.length}`,
    );
  }
  if (
    (plan.proposed_paths.length === 0 && plan.estimated_changed_lines !== 0) ||
    (plan.proposed_paths.length > 0 && plan.estimated_changed_lines < plan.proposed_paths.length)
  ) {
    objections.push(
      `plan.estimated_changed_lines_inconsistent:${plan.estimated_changed_lines}:${plan.proposed_paths.length}`,
    );
  }
}

function isCanonicalRepositoryPath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    !candidate.includes("\\") &&
    !candidate.includes("\0") &&
    !path.posix.isAbsolute(candidate) &&
    !/^[A-Za-z]:/u.test(candidate) &&
    candidate !== "." &&
    candidate !== ".." &&
    !candidate.startsWith("../") &&
    path.posix.normalize(candidate) === candidate
  );
}

function matchesPathPattern(candidate: string, pattern: string): boolean {
  if (!isCanonicalRepositoryPath(candidate) || !isCanonicalRepositoryPath(pattern)) return false;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u").test(candidate);
}
