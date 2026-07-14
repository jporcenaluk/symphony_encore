import { describe, expect, it } from "vitest";

import { validatePlan } from "./plan-policy.js";

const criteria = [
  { id: "AC-1", text: "Persists the attempt" },
  { id: "AC-2", text: "Rejects duplicate terminal results" },
];

const validPlan = {
  acceptanceCriteria: [
    {
      criterionId: "AC-1",
      criterionText: "Persists the attempt",
      plannedEvidence: "migration integration test",
    },
    {
      criterionId: "AC-2",
      criterionText: "Rejects duplicate terminal results",
      plannedEvidence: "transaction uniqueness test",
    },
  ],
  approach: "Add the schema and transactional repository together.",
  estimatedChangedLines: 120,
  estimatedFiles: 2,
  proposedPaths: ["packages/domain/src/attempt.ts", "packages/persistence/src/attempt.ts"],
  riskFacts: ["risk.migration_data"],
  verificationCommands: ["make test-integration"],
};

describe("plan policy", () => {
  it("accepts complete, internally consistent criterion mapping", () => {
    expect(validatePlan(criteria, validPlan)).toEqual({ ok: true });
  });

  it("routes an issue without structured criteria to needs_input", () => {
    expect(validatePlan([], { ...validPlan, acceptanceCriteria: [] })).toEqual({
      ok: false,
      reason: "plan.issue_not_ready",
    });
  });

  it("reports every missing or altered criterion", () => {
    expect(
      validatePlan(criteria, {
        ...validPlan,
        acceptanceCriteria: [
          {
            criterionId: "AC-1",
            criterionText: "Different text",
            plannedEvidence: "a test",
          },
        ],
      }),
    ).toEqual({
      details: ["AC-1", "AC-2"],
      ok: false,
      reason: "plan.criteria_incomplete",
    });
  });

  it("requires at least one verification command", () => {
    expect(validatePlan(criteria, { ...validPlan, verificationCommands: [] })).toEqual({
      ok: false,
      reason: "plan.verification_missing",
    });
  });

  it("rejects duplicate paths and mismatched file estimates", () => {
    expect(
      validatePlan(criteria, {
        ...validPlan,
        estimatedFiles: 3,
        proposedPaths: ["packages/domain/src/attempt.ts", "packages/domain/src/attempt.ts"],
      }),
    ).toEqual({ ok: false, reason: "plan.size_inconsistent" });
  });
});
