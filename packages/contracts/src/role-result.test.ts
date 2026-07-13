import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  AdjudicationResultSchema,
  PlanReviewResultSchema,
  ReviewResultSchema,
  SynthesisResultSchema,
  validateAdjudicationResult,
} from "./role-result.js";

const evidence = [{ kind: "file" as const, path: "SPEC.md" }];
const handoff = {
  acceptance_criteria: ["criterion-1"],
  commands: [],
  decisions_fixed: [],
  files_changed: [],
  goal: "Review the plan",
  open_items: [],
  revision: "abc123",
};
const blockingFinding = {
  behavior: "migration loses durable state",
  blocking: true,
  evidence,
  id: "finding-1",
  severity: "high",
};
const blockingReviewFinding = {
  ...blockingFinding,
  disposition: "Add a rollback-safe migration test",
};

describe("plan review results", () => {
  it("allows approve only without blocking findings or a question", () => {
    expect(
      Value.Check(PlanReviewResultSchema, {
        decision: "approve",
        evidence,
        findings: [],
        handoff,
        plan_revision: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(PlanReviewResultSchema, {
        decision: "approve",
        evidence,
        findings: [blockingFinding],
        handoff,
        plan_revision: 1,
      }),
    ).toBe(false);
  });

  it("requires blocking evidence for needs_rework and a question for needs_input", () => {
    expect(
      Value.Check(PlanReviewResultSchema, {
        decision: "needs_rework",
        evidence,
        findings: [blockingFinding],
        handoff,
        plan_revision: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(PlanReviewResultSchema, {
        decision: "needs_rework",
        evidence,
        findings: [],
        handoff,
        plan_revision: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(PlanReviewResultSchema, {
        decision: "needs_input",
        evidence,
        findings: [],
        handoff,
        plan_revision: 1,
        question: { default: "A", options: ["A", "B"], text: "Choose" },
      }),
    ).toBe(true);
  });
});

describe("review results", () => {
  it("requires non-approve decisions to carry routing evidence", () => {
    expect(
      Value.Check(ReviewResultSchema, {
        decision: "needs_human",
        evidence,
        findings: [blockingReviewFinding],
        target_sha: "abcdef1",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewResultSchema, {
        decision: "needs_human",
        evidence: [],
        findings: [blockingReviewFinding],
        target_sha: "abcdef1",
      }),
    ).toBe(false);
  });
});

describe("adjudication results", () => {
  it("requires exactly one resolution for every conflict", () => {
    const result = {
      conflict_ids: ["conflict-1", "conflict-2"],
      decision: "resolve" as const,
      evidence,
      resolutions: [
        {
          conflict_id: "conflict-1",
          evidence,
          rationale: "The transaction test proves the first finding",
          rejected_finding_ids: ["finding-2"],
          upheld_finding_ids: ["finding-1"],
        },
      ],
      target_sha: "abcdef1",
    };
    expect(Value.Check(AdjudicationResultSchema, result)).toBe(true);
    expect(validateAdjudicationResult(result)).toEqual({
      ok: false,
      reason: "adjudication.resolution_set_mismatch",
    });
  });
});

describe("synthesis results", () => {
  it("requires repository and pull-request fields only for proposed changes", () => {
    const proposed = {
      branch: "symphony/system-synthesis-1",
      cited_lesson_ids: ["lesson-1"],
      decision: "propose_changes",
      evidence,
      handoff,
      pull_request: { base_ref: "main", title: "docs: refine workflow rules" },
      repository_revision: "abcdef1",
      rule_changes: [
        {
          action: "add",
          lesson_ids: ["lesson-1"],
          rationale: "Repeated guard failures",
          rule_id: "rule-1",
          text: "Run migration tests before completion.",
        },
      ],
    };
    expect(Value.Check(SynthesisResultSchema, proposed)).toBe(true);
    expect(
      Value.Check(SynthesisResultSchema, {
        ...proposed,
        decision: "no_change",
        rule_changes: [],
      }),
    ).toBe(false);
  });
});
