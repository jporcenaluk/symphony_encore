import path from "node:path";

import type { ComputeProfile } from "@symphony/domain";

import { isDeterministicPredicate } from "./config/compute-policy.js";

const ENTRY_KEYS = [
  "concerns",
  "excluded_context",
  "name",
  "profile",
  "required_evidence",
  "trigger_rules",
] as const;
const PROFILES = new Set<ComputeProfile>(["economy", "standard", "deep"]);

export interface ReviewSpecialist {
  concerns: readonly string[];
  excludedContext: readonly string[];
  name: string;
  profile: ComputeProfile;
  requiredEvidence: readonly string[];
  triggerRules: readonly string[];
}

export interface SpecialistTriggerFacts {
  acceptanceCriteriaPresent: boolean;
  changedLines: number;
  changedPaths: readonly string[];
  facts: ReadonlySet<string>;
  proposedPaths: readonly string[];
}

export interface RequiredSpecialist {
  specialist: ReviewSpecialist;
  triggeringRules: readonly string[];
}

export function parseReviewSpecialists(value: unknown): readonly ReviewSpecialist[] {
  if (!Array.isArray(value)) throw new Error("config.review_specialist_invalid");
  const names = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) invalid();
    const {
      concerns,
      excluded_context: excludedContext,
      name,
      profile,
      required_evidence: requiredEvidence,
      trigger_rules: triggerRules,
    } = entry;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !isProfile(profile) ||
      !isUniqueStringList(concerns, true) ||
      !isUniqueStringList(excludedContext, false) ||
      !isUniqueStringList(requiredEvidence, true) ||
      !isUniqueStringList(triggerRules, true)
    ) {
      invalid();
    }
    if (names.has(name)) throw new Error(`config.review_specialist_duplicate:${name}`);
    names.add(name);
    for (const rule of triggerRules) {
      if (!isDeterministicPredicate(rule)) {
        throw new Error(`config.review_specialist_predicate_unknown:${rule}`);
      }
    }
    return {
      concerns: [...concerns],
      excludedContext: [...excludedContext],
      name,
      profile,
      requiredEvidence: [...requiredEvidence],
      triggerRules: [...triggerRules],
    };
  });
}

export function selectRequiredSpecialists(
  specialists: readonly ReviewSpecialist[],
  facts: SpecialistTriggerFacts,
): readonly RequiredSpecialist[] {
  return specialists.flatMap((specialist) => {
    const triggeringRules = specialist.triggerRules.filter((rule) => predicateMatches(rule, facts));
    return triggeringRules.length > 0 ? [{ specialist, triggeringRules }] : [];
  });
}

function predicateMatches(predicate: string, facts: SpecialistTriggerFacts): boolean {
  if (predicate === "acceptance_criteria:present") return facts.acceptanceCriteriaPresent;
  if (predicate === "acceptance_criteria:missing") return !facts.acceptanceCriteriaPresent;
  if (predicate.startsWith("diff_lines_gte:")) {
    return facts.changedLines >= Number(predicate.slice("diff_lines_gte:".length));
  }
  if (predicate.startsWith("changed_path:")) {
    const pattern = predicate.slice("changed_path:".length);
    return facts.changedPaths.some((candidate) => matchesPathPattern(candidate, pattern));
  }
  if (predicate.startsWith("proposed_path:")) {
    const pattern = predicate.slice("proposed_path:".length);
    return facts.proposedPaths.some((candidate) => matchesPathPattern(candidate, pattern));
  }
  return facts.facts.has(predicate);
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const sorted = [...expected].sort((left, right) => left.localeCompare(right));
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isUniqueStringList(value: unknown, requireNonempty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireNonempty || value.length > 0) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function isProfile(value: unknown): value is ComputeProfile {
  return typeof value === "string" && PROFILES.has(value as ComputeProfile);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("config.review_specialist_invalid");
}
