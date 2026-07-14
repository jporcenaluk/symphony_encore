import type { ChangeClass } from "./change-classification.js";

export type ComputeProfile = "economy" | "standard" | "deep";

export type AttemptRole =
  | "plan_review"
  | "implementation"
  | "integrative_review"
  | "specialist_review"
  | "adjudication"
  | "synthesis";

export interface ResolvedComputeProfile {
  model: string;
  reasoningEffort: string;
}

export interface ComputeRouteProfiles {
  adjudication: ComputeProfile;
  implementation: Readonly<Record<ChangeClass, ComputeProfile>>;
  integrative_review: ComputeProfile;
  plan_review: ComputeProfile;
  specialist_review: ComputeProfile;
  synthesis: ComputeProfile;
}

export interface ComputeRiskFloorRule {
  id: string;
  minimumProfile: ComputeProfile;
  roles: readonly AttemptRole[];
  whenFact: string;
}

export interface ComputeRouteInput {
  changeClass: ChangeClass;
  enabledProfiles: readonly ComputeProfile[];
  facts: ReadonlySet<string>;
  heuristicMinimum: ComputeProfile | null;
  resolvedProfiles: Readonly<Record<ComputeProfile, ResolvedComputeProfile>>;
  routeProfiles: ComputeRouteProfiles;
  riskFloorRules: readonly ComputeRiskFloorRule[];
  role: AttemptRole;
}

export interface ComputeRoute {
  model: string;
  profile: ComputeProfile;
  reasoningEffort: string;
  reasons: readonly string[];
}

const PROFILE_RANK: Readonly<Record<ComputeProfile, number>> = {
  economy: 0,
  standard: 1,
  deep: 2,
};

function defaultRoute(
  role: AttemptRole,
  changeClass: ChangeClass,
  profiles: ComputeRouteProfiles,
): { profile: ComputeProfile; reason: string } {
  if (role === "implementation") {
    return {
      profile: profiles.implementation[changeClass],
      reason: `route.implementation.${changeClass}`,
    };
  }
  return { profile: profiles[role], reason: `route.${role}` };
}

function strongerProfile(current: ComputeProfile, candidate: ComputeProfile): ComputeProfile {
  return PROFILE_RANK[candidate] > PROFILE_RANK[current] ? candidate : current;
}

export function selectComputeRoute(input: ComputeRouteInput): ComputeRoute {
  const base = defaultRoute(input.role, input.changeClass, input.routeProfiles);
  let profile = base.profile;
  const reasons = [base.reason];

  for (const rule of input.riskFloorRules) {
    if (rule.roles.includes(input.role) && input.facts.has(rule.whenFact)) {
      profile = strongerProfile(profile, rule.minimumProfile);
      reasons.push(rule.id);
    }
  }

  if (
    input.heuristicMinimum !== null &&
    PROFILE_RANK[input.heuristicMinimum] > PROFILE_RANK[profile]
  ) {
    profile = input.heuristicMinimum;
    reasons.push("route.heuristic_raise");
  }

  if (!input.enabledProfiles.includes(profile)) {
    throw new Error(`Selected compute profile is disabled: ${profile}`);
  }
  const resolved = input.resolvedProfiles[profile];
  return {
    model: resolved.model,
    profile,
    reasoningEffort: resolved.reasoningEffort,
    reasons,
  };
}

export interface EscalationInput {
  budgetFits: boolean;
  currentProfile: ComputeProfile;
  escalationsUsed: number;
  maxEscalations: number;
  requestedProfile: ComputeProfile;
}

export type EscalationDecision =
  | { allow: true }
  | {
      allow: false;
      reason: "escalation.budget_denied" | "escalation.limit_reached" | "escalation.not_stronger";
    };

export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (!input.budgetFits) {
    return { allow: false, reason: "escalation.budget_denied" };
  }
  if (input.escalationsUsed >= input.maxEscalations) {
    return { allow: false, reason: "escalation.limit_reached" };
  }
  if (PROFILE_RANK[input.requestedProfile] <= PROFILE_RANK[input.currentProfile]) {
    return { allow: false, reason: "escalation.not_stronger" };
  }
  return { allow: true };
}
