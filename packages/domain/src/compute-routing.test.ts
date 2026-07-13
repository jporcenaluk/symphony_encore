import { describe, expect, it } from "vitest";

import { decideEscalation, selectComputeRoute } from "./compute-routing.js";

const baseInput = {
  changeClass: "trivial" as const,
  enabledProfiles: ["economy", "standard", "deep"] as const,
  facts: new Set<string>(),
  heuristicMinimum: null,
  resolvedProfiles: {
    deep: { model: "deep-model", reasoningEffort: "high" },
    economy: { model: "economy-model", reasoningEffort: "low" },
    standard: { model: "standard-model", reasoningEffort: "medium" },
  },
  riskFloorRules: [
    {
      id: "risk.security_auth",
      minimumProfile: "deep" as const,
      roles: ["implementation" as const],
      whenFact: "security_auth",
    },
    {
      id: "risk.public_api",
      minimumProfile: "deep" as const,
      roles: ["implementation" as const],
      whenFact: "public_api",
    },
  ],
  role: "implementation" as const,
};

describe("compute routing", () => {
  it("uses role and class defaults", () => {
    expect(selectComputeRoute(baseInput)).toEqual({
      model: "economy-model",
      profile: "economy",
      reasoningEffort: "low",
      reasons: ["route.implementation.trivial"],
    });
    expect(
      selectComputeRoute({ ...baseInput, changeClass: "high_risk", role: "plan_review" }),
    ).toMatchObject({ profile: "economy", reasons: ["route.plan_review"] });
  });

  it("applies the highest matching deterministic floor in rule order", () => {
    expect(
      selectComputeRoute({
        ...baseInput,
        facts: new Set(["security_auth", "public_api"]),
      }),
    ).toEqual({
      model: "deep-model",
      profile: "deep",
      reasoningEffort: "high",
      reasons: ["route.implementation.trivial", "risk.security_auth", "risk.public_api"],
    });
  });

  it("lets a heuristic raise but never lower the deterministic route", () => {
    expect(selectComputeRoute({ ...baseInput, heuristicMinimum: "standard" })).toMatchObject({
      profile: "standard",
      reasons: ["route.implementation.trivial", "route.heuristic_raise"],
    });
    expect(
      selectComputeRoute({
        ...baseInput,
        changeClass: "high_risk",
        heuristicMinimum: "economy",
      }),
    ).toMatchObject({ profile: "deep", reasons: ["route.implementation.high_risk"] });
  });
});

describe("escalation policy", () => {
  it("requires a stronger profile, remaining escalation allowance, and budget", () => {
    expect(
      decideEscalation({
        budgetFits: true,
        currentProfile: "economy",
        escalationsUsed: 0,
        maxEscalations: 1,
        requestedProfile: "standard",
      }),
    ).toEqual({ allow: true });
    expect(
      decideEscalation({
        budgetFits: false,
        currentProfile: "economy",
        escalationsUsed: 0,
        maxEscalations: 1,
        requestedProfile: "deep",
      }),
    ).toEqual({ allow: false, reason: "escalation.budget_denied" });
    expect(
      decideEscalation({
        budgetFits: true,
        currentProfile: "standard",
        escalationsUsed: 1,
        maxEscalations: 1,
        requestedProfile: "deep",
      }),
    ).toEqual({ allow: false, reason: "escalation.limit_reached" });
    expect(
      decideEscalation({
        budgetFits: true,
        currentProfile: "deep",
        escalationsUsed: 0,
        maxEscalations: 1,
        requestedProfile: "standard",
      }),
    ).toEqual({ allow: false, reason: "escalation.not_stronger" });
  });
});
