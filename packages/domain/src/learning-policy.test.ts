import { describe, expect, it } from "vitest";

import { decayedRuleIds, decideSynthesisTrigger, validateRuleChanges } from "./learning-policy.js";

describe("learning synthesis trigger", () => {
  it("queues one supervised deep SystemJob at the interval or by operator request", () => {
    expect(
      decideSynthesisTrigger({
        activeSynthesisJobs: 0,
        completedIssuesSinceLastSynthesis: 25,
        intervalIssues: 25,
        operatorRequested: false,
      }),
    ).toEqual({
      computeProfile: "deep",
      decision: "queue",
      jobKind: "synthesis",
      supervision: "supervised",
      trigger: "interval",
    });
    expect(
      decideSynthesisTrigger({
        activeSynthesisJobs: 0,
        completedIssuesSinceLastSynthesis: 0,
        intervalIssues: 25,
        operatorRequested: true,
      }),
    ).toEqual(expect.objectContaining({ decision: "queue", trigger: "operator" }));
  });

  it("never queues a duplicate active synthesis job", () => {
    expect(
      decideSynthesisTrigger({
        activeSynthesisJobs: 1,
        completedIssuesSinceLastSynthesis: 30,
        intervalIssues: 25,
        operatorRequested: true,
      }),
    ).toEqual({ decision: "wait", reason: "learning.synthesis_already_active" });
  });
});

describe("learning saturation", () => {
  const rules = [
    { id: "R1", lessonIds: ["L1"], text: "Preserve evidence." },
    { id: "R2", lessonIds: ["L2"], text: "Verify before merge." },
  ];

  it("requires cited lessons and enforces both hard caps", () => {
    expect(
      validateRuleChanges({
        changes: [
          {
            action: "add",
            lessonIds: [],
            rationale: "Observed repeated failures",
            ruleId: "R3",
            text: "Check the failure.",
          },
        ],
        currentRules: rules,
        maxPromptTokens: 100,
        maxRules: 3,
        proposedPromptTokens: 50,
      }),
    ).toEqual({ ok: false, reason: "learning.rule_lessons_required", ruleId: "R3" });

    expect(
      validateRuleChanges({
        changes: [
          {
            action: "add",
            lessonIds: ["L3"],
            rationale: "Observed repeated failures",
            ruleId: "R3",
            text: "Check the failure.",
          },
        ],
        currentRules: rules,
        maxPromptTokens: 100,
        maxRules: 2,
        proposedPromptTokens: 50,
      }),
    ).toEqual({ ok: false, reason: "learning.max_rules_exceeded" });

    expect(
      validateRuleChanges({
        changes: [],
        currentRules: rules,
        maxPromptTokens: 40,
        maxRules: 2,
        proposedPromptTokens: 41,
      }),
    ).toEqual({ ok: false, reason: "learning.max_prompt_tokens_exceeded" });
  });

  it("permits a cited replacement at the rule cap and reports the resulting rules", () => {
    expect(
      validateRuleChanges({
        changes: [
          {
            action: "remove",
            lessonIds: ["L2", "L3"],
            rationale: "R2 is superseded by a more specific lesson-backed rule",
            ruleId: "R2",
            text: "Verify before merge.",
          },
          {
            action: "add",
            lessonIds: ["L3"],
            rationale: "Repeated review finding",
            ruleId: "R3",
            text: "Verify the exact merge revision.",
          },
        ],
        currentRules: rules,
        maxPromptTokens: 100,
        maxRules: 2,
        proposedPromptTokens: 60,
      }),
    ).toEqual({
      ok: true,
      rules: [
        { id: "R1", lessonIds: ["L1"], text: "Preserve evidence." },
        { id: "R3", lessonIds: ["L3"], text: "Verify the exact merge revision." },
      ],
    });
  });

  it("rejects updates and removals for unknown rules", () => {
    expect(
      validateRuleChanges({
        changes: [
          {
            action: "remove",
            lessonIds: ["L4"],
            rationale: "No longer useful",
            ruleId: "R4",
            text: "Unknown.",
          },
        ],
        currentRules: rules,
        maxPromptTokens: 100,
        maxRules: 2,
        proposedPromptTokens: 50,
      }),
    ).toEqual({ ok: false, reason: "learning.rule_not_found", ruleId: "R4" });
  });
});

describe("rule decay", () => {
  it("proposes rules uncited for the configured completed-issue window", () => {
    expect(
      decayedRuleIds({
        currentCompletedIssue: 140,
        ruleDecayIssues: 100,
        rules: [
          { createdCompletedIssue: 0, id: "R1", lastCitedCompletedIssue: 40 },
          { createdCompletedIssue: 0, id: "R2", lastCitedCompletedIssue: 41 },
          { createdCompletedIssue: 40, id: "R3", lastCitedCompletedIssue: null },
          { createdCompletedIssue: 41, id: "R4", lastCitedCompletedIssue: null },
        ],
      }),
    ).toEqual(["R1", "R3"]);
  });
});
