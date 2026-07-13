import { describe, expect, it } from "vitest";

import { parseComputeRoutingPolicy } from "./compute-policy.js";

const routeProfiles = {
  adjudication: "deep",
  implementation: { high_risk: "deep", standard: "standard", trivial: "economy" },
  integrative_review: "standard",
  plan_review: "economy",
  specialist_review: "deep",
  synthesis: "deep",
};

describe("compute routing configuration", () => {
  it("maps strict role profiles and deterministic risk predicates", () => {
    expect(
      parseComputeRoutingPolicy({
        riskFloorRules: [
          {
            id: "risk.security_auth",
            minimum_profile: "deep",
            roles: ["implementation", "specialist_review"],
            when: "label:security",
          },
          {
            id: "risk.large_diff",
            minimum_profile: "standard",
            roles: ["implementation"],
            when: "diff_lines_gte:500",
          },
        ],
        routeProfiles,
      }),
    ).toEqual({
      riskFloorRules: [
        {
          id: "risk.security_auth",
          minimumProfile: "deep",
          roles: ["implementation", "specialist_review"],
          whenFact: "label:security",
        },
        {
          id: "risk.large_diff",
          minimumProfile: "standard",
          roles: ["implementation"],
          whenFact: "diff_lines_gte:500",
        },
      ],
      routeProfiles,
    });
  });

  it.each([
    [{ ...routeProfiles, plan_review: "turbo" }, [], "config.compute_route_profiles_invalid"],
    [
      { ...routeProfiles, implementation: { standard: "standard" } },
      [],
      "config.compute_route_profiles_invalid",
    ],
    [
      routeProfiles,
      [{ id: "x", minimum_profile: "deep", roles: [], when: "label:x" }],
      "config.compute_risk_floor_rule_invalid",
    ],
    [
      routeProfiles,
      [{ id: "x", minimum_profile: "deep", roles: ["builder"], when: "label:x" }],
      "config.compute_risk_floor_rule_invalid",
    ],
    [
      routeProfiles,
      [{ id: "x", minimum_profile: "deep", roles: ["implementation"], when: "mood:scary" }],
      "config.compute_risk_predicate_unknown:mood:scary",
    ],
  ])("rejects invalid policy", (profiles, rules, code) => {
    expect(() =>
      parseComputeRoutingPolicy({ routeProfiles: profiles, riskFloorRules: rules }),
    ).toThrow(code);
  });

  it("rejects duplicate rule ids", () => {
    const rule = {
      id: "risk.same",
      minimum_profile: "deep",
      roles: ["implementation"],
      when: "risk.concurrency",
    };
    expect(() =>
      parseComputeRoutingPolicy({ routeProfiles, riskFloorRules: [rule, rule] }),
    ).toThrow("config.compute_risk_floor_rule_duplicate:risk.same");
  });
});
