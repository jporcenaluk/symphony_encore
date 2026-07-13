import type { Plan } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { classifyImplementationPlan, validateImplementationPlan } from "./plan-gate.js";

const validPlan: Plan = {
  acceptance_criteria: [
    {
      criterion_id: "criterion-1",
      criterion_text: "Persist the submitted configuration",
      planned_evidence: "A persistence integration test",
    },
    {
      criterion_id: "criterion-2",
      criterion_text: "Reject stale versions",
      planned_evidence: "A stale-version API test",
    },
  ],
  approach: "Update the transactional configuration path and its boundary tests.",
  approved_by_attempt_id: null,
  created_at: "2026-07-13T10:00:00.000Z",
  created_by_attempt_id: "attempt-1",
  estimated_changed_lines: 40,
  estimated_files: 2,
  id: "plan-1",
  proposed_paths: ["apps/server/src/configuration.ts", "apps/server/src/configuration.test.ts"],
  revision: 1,
  risk_facts: [],
  status: "draft",
  validated_at: null,
  verification_commands: ["pnpm test configuration.test.ts"],
  work_ref: { issue_id: "issue-1" },
};

describe("deterministic implementation Plan gate", () => {
  it("accepts exact criterion coverage with safe unique paths and consistent estimates", () => {
    expect(
      validateImplementationPlan({
        acceptanceCriteria: ["Persist the submitted configuration", "Reject stale versions"],
        plan: validPlan,
      }),
    ).toEqual({ accepted: true, objections: [] });
  });

  it("computes the first authoritative class from configured path and size facts", () => {
    const unknownProvisional = {
      changeClass: "standard" as const,
      floor: null,
      reasons: ["classification.unknown"],
    };
    expect(
      classifyImplementationPlan({
        plan: {
          ...validPlan,
          estimated_changed_lines: 10,
          estimated_files: 1,
          proposed_paths: ["docs/operator/guide.md"],
        },
        provisional: unknownProvisional,
        riskPathPatterns: [],
        trivialMaxChangedLines: 25,
        trivialPathPatterns: ["docs/**"],
      }),
    ).toEqual({
      changeClass: "trivial",
      reasons: ["classification.trivial_paths", "classification.trivial_size"],
    });
    expect(
      classifyImplementationPlan({
        plan: validPlan,
        provisional: unknownProvisional,
        riskPathPatterns: ["apps/server/src/**"],
        trivialMaxChangedLines: 25,
        trivialPathPatterns: ["docs/**"],
      }),
    ).toEqual({
      changeClass: "high_risk",
      reasons: ["risk.configured_path:apps/server/src/**"],
    });
    expect(
      classifyImplementationPlan({
        plan: {
          ...validPlan,
          estimated_changed_lines: 10,
          estimated_files: 1,
          proposed_paths: ["docs/operator/guide.md"],
        },
        provisional: {
          changeClass: "standard",
          floor: "standard",
          reasons: ["classification.explicit_standard"],
        },
        riskPathPatterns: [],
        trivialMaxChangedLines: 25,
        trivialPathPatterns: ["docs/**"],
      }),
    ).toEqual({
      changeClass: "standard",
      reasons: ["classification.explicit_standard"],
    });
  });

  it("returns stable specific objections for coverage, path, and size defects", () => {
    expect(
      validateImplementationPlan({
        acceptanceCriteria: ["Persist the submitted configuration", "Reject stale versions"],
        plan: {
          ...validPlan,
          acceptance_criteria: [
            validPlan.acceptance_criteria[0] as (typeof validPlan.acceptance_criteria)[number],
            {
              criterion_id: "criterion-copy",
              criterion_text: "Persist the submitted configuration",
              planned_evidence: "Duplicate coverage",
            },
            {
              criterion_id: "criterion-extra",
              criterion_text: "Add an unrelated feature",
              planned_evidence: "An unrelated test",
            },
          ],
          estimated_changed_lines: 0,
          estimated_files: 1,
          proposed_paths: ["apps/server/src/configuration.ts", "../outside.ts"],
        },
      }),
    ).toEqual({
      accepted: false,
      objections: [
        "plan.acceptance_criterion_duplicate:Persist the submitted configuration",
        "plan.acceptance_criterion_unknown:Add an unrelated feature",
        "plan.acceptance_criterion_missing:Reject stale versions",
        "plan.path_invalid:../outside.ts",
        "plan.estimated_files_mismatch:1:2",
        "plan.estimated_changed_lines_inconsistent:0:2",
      ],
    });
  });

  it("rejects duplicate criterion identities and non-canonical repository paths", () => {
    expect(
      validateImplementationPlan({
        acceptanceCriteria: ["Persist the submitted configuration", "Reject stale versions"],
        plan: {
          ...validPlan,
          acceptance_criteria: validPlan.acceptance_criteria.map((criterion) => ({
            ...criterion,
            criterion_id: "criterion-1",
          })),
          estimated_files: 3,
          proposed_paths: [
            "apps/server/src/configuration.ts",
            "apps/server/src/configuration.ts",
            "apps\\server\\src\\configuration.test.ts",
          ],
        },
      }),
    ).toEqual({
      accepted: false,
      objections: [
        "plan.acceptance_criterion_id_duplicate:criterion-1",
        "plan.path_duplicate:apps/server/src/configuration.ts",
        "plan.path_invalid:apps\\server\\src\\configuration.test.ts",
      ],
    });
  });
});
