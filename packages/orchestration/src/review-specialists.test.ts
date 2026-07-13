import { describe, expect, it } from "vitest";

import { parseReviewSpecialists, selectRequiredSpecialists } from "./review-specialists.js";

const configured = [
  {
    concerns: ["security", "failure_modes"],
    excluded_context: ["builder_narrative"],
    name: "systems_security",
    profile: "deep",
    required_evidence: ["diff", "checks"],
    trigger_rules: ["risk.security_auth", "changed_path:infra/**"],
  },
  {
    concerns: ["product_behavior"],
    excluded_context: ["self_review"],
    name: "architecture_product",
    profile: "deep",
    required_evidence: ["diff", "acceptance_criteria"],
    trigger_rules: ["risk.public_api", "diff_lines_gte:500"],
  },
];

describe("review specialist policy", () => {
  it("parses exact entries and selects every matching specialist in configured order", () => {
    const specialists = parseReviewSpecialists(configured);
    expect(
      selectRequiredSpecialists(specialists, {
        acceptanceCriteriaPresent: true,
        changedLines: 600,
        changedPaths: ["infra/workflow.yml"],
        facts: new Set(["risk.security_auth"]),
        proposedPaths: [],
      }),
    ).toEqual([
      {
        specialist: specialists[0],
        triggeringRules: ["risk.security_auth", "changed_path:infra/**"],
      },
      { specialist: specialists[1], triggeringRules: ["diff_lines_gte:500"] },
    ]);
  });

  it("rejects duplicate names, unknown predicates, extra keys, and malformed profiles", () => {
    expect(() => parseReviewSpecialists([...configured, configured[0]])).toThrow(
      "config.review_specialist_duplicate:systems_security",
    );
    expect(() =>
      parseReviewSpecialists([{ ...configured[0], trigger_rules: ["issue_text:security"] }]),
    ).toThrow("config.review_specialist_predicate_unknown:issue_text:security");
    expect(() => parseReviewSpecialists([{ ...configured[0], extra: true }])).toThrow(
      "config.review_specialist_invalid",
    );
    expect(() => parseReviewSpecialists([{ ...configured[0], profile: "largest" }])).toThrow(
      "config.review_specialist_invalid",
    );
  });
});
