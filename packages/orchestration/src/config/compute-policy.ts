import type {
  AttemptRole,
  ComputeProfile,
  ComputeRiskFloorRule,
  ComputeRouteProfiles,
} from "@symphony/domain";

const PROFILES = new Set<ComputeProfile>(["economy", "standard", "deep"]);
const ROLES = new Set<AttemptRole>([
  "plan_review",
  "implementation",
  "integrative_review",
  "specialist_review",
  "adjudication",
  "synthesis",
]);
const BUILT_IN_FACTS = new Set([
  "risk.security_auth",
  "risk.migration_data",
  "risk.concurrency",
  "risk.public_api",
  "risk.cross_package_architecture",
  "risk.ambiguous_criteria",
]);
const ROUTE_KEYS = [
  "adjudication",
  "implementation",
  "integrative_review",
  "plan_review",
  "specialist_review",
  "synthesis",
] as const;
const IMPLEMENTATION_KEYS = ["high_risk", "standard", "trivial"] as const;
const RULE_KEYS = ["id", "minimum_profile", "roles", "when"] as const;

export interface ParsedComputeRoutingPolicy {
  riskFloorRules: readonly ComputeRiskFloorRule[];
  routeProfiles: ComputeRouteProfiles;
}

export function parseComputeRoutingPolicy(input: {
  riskFloorRules: unknown;
  routeProfiles: unknown;
}): ParsedComputeRoutingPolicy {
  const routeProfiles = parseRouteProfiles(input.routeProfiles);
  if (!Array.isArray(input.riskFloorRules)) {
    throw new Error("config.compute_risk_floor_rule_invalid");
  }
  const ids = new Set<string>();
  const riskFloorRules = input.riskFloorRules.map((value) => {
    if (!isRecord(value) || !hasExactKeys(value, RULE_KEYS)) {
      throw new Error("config.compute_risk_floor_rule_invalid");
    }
    const { id, minimum_profile: minimumProfile, roles, when } = value;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      !isProfile(minimumProfile) ||
      !Array.isArray(roles) ||
      roles.length === 0 ||
      roles.some((role) => !isRole(role)) ||
      new Set(roles).size !== roles.length ||
      typeof when !== "string" ||
      when.trim().length === 0
    ) {
      throw new Error("config.compute_risk_floor_rule_invalid");
    }
    if (ids.has(id)) throw new Error(`config.compute_risk_floor_rule_duplicate:${id}`);
    ids.add(id);
    if (!isDeterministicPredicate(when)) {
      throw new Error(`config.compute_risk_predicate_unknown:${when}`);
    }
    return {
      id,
      minimumProfile,
      roles: [...roles] as AttemptRole[],
      whenFact: when,
    };
  });
  return { riskFloorRules, routeProfiles };
}

function parseRouteProfiles(value: unknown): ComputeRouteProfiles {
  if (!isRecord(value) || !hasExactKeys(value, ROUTE_KEYS)) invalidRoutes();
  const implementation = value.implementation;
  if (
    !isRecord(implementation) ||
    !hasExactKeys(implementation, IMPLEMENTATION_KEYS) ||
    !IMPLEMENTATION_KEYS.every((key) => isProfile(implementation[key]))
  ) {
    invalidRoutes();
  }
  for (const key of ROUTE_KEYS) {
    if (key !== "implementation" && !isProfile(value[key])) invalidRoutes();
  }
  return {
    adjudication: value.adjudication as ComputeProfile,
    implementation: {
      high_risk: implementation.high_risk as ComputeProfile,
      standard: implementation.standard as ComputeProfile,
      trivial: implementation.trivial as ComputeProfile,
    },
    integrative_review: value.integrative_review as ComputeProfile,
    plan_review: value.plan_review as ComputeProfile,
    specialist_review: value.specialist_review as ComputeProfile,
    synthesis: value.synthesis as ComputeProfile,
  };
}

export function isDeterministicPredicate(value: string): boolean {
  return (
    BUILT_IN_FACTS.has(value) ||
    /^(?:label|dependency|change_fact):[^:\s][^\s]*$/u.test(value) ||
    /^(?:proposed_path|changed_path):\S+$/u.test(value) ||
    /^diff_lines_gte:[1-9][0-9]*$/u.test(value) ||
    /^acceptance_criteria:(?:present|missing)$/u.test(value)
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isProfile(value: unknown): value is ComputeProfile {
  return typeof value === "string" && PROFILES.has(value as ComputeProfile);
}

function isRole(value: unknown): value is AttemptRole {
  return typeof value === "string" && ROLES.has(value as AttemptRole);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRoutes(): never {
  throw new Error("config.compute_route_profiles_invalid");
}
