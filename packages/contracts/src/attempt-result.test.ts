import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ImplementationOutcomeSchema,
  validateOperatorQuestion,
  WorkRefSchema,
} from "./attempt-result.js";

const handoff = {
  acceptance_criteria: ["criterion-1"],
  commands: [{ command: "make verify", exit_code: 0 }],
  decisions_fixed: ["use SQLite"],
  files_changed: ["packages/domain/src/index.ts"],
  goal: "Implement the issue",
  open_items: [],
  revision: "abc123",
};

const common = {
  actions_requested: [],
  confusions: [],
  evidence: [{ kind: "file", path: "packages/domain/src/index.ts" }],
  handoff,
  summary: "Implemented and verified the change",
};

describe("work references", () => {
  it("accepts exactly one issue or SystemJob identifier", () => {
    expect(Value.Check(WorkRefSchema, { issue_id: "issue-1" })).toBe(true);
    expect(Value.Check(WorkRefSchema, { system_job_id: "job-1" })).toBe(true);
    expect(Value.Check(WorkRefSchema, { issue_id: "issue-1", system_job_id: "job-1" })).toBe(false);
    expect(Value.Check(WorkRefSchema, {})).toBe(false);
  });
});

describe("implementation outcomes", () => {
  it("requires verification evidence for completed outcomes", () => {
    expect(
      Value.Check(ImplementationOutcomeSchema, {
        ...common,
        status: "completed",
        verification: { command: "make verify", exit_code: 0, result: "passed" },
      }),
    ).toBe(true);
    expect(Value.Check(ImplementationOutcomeSchema, { ...common, status: "completed" })).toBe(
      false,
    );
  });

  it("requires a structured question only for needs_input", () => {
    const question = {
      default: "Use the existing schema",
      options: ["Use the existing schema", "Add a new schema"],
      text: "Which schema owns the field?",
    };
    expect(
      Value.Check(ImplementationOutcomeSchema, { ...common, question, status: "needs_input" }),
    ).toBe(true);
    expect(Value.Check(ImplementationOutcomeSchema, { ...common, status: "needs_input" })).toBe(
      false,
    );
    expect(
      Value.Check(ImplementationOutcomeSchema, { ...common, question, status: "blocked" }),
    ).toBe(false);
  });

  it("rejects unrecognized fields instead of silently accepting protocol drift", () => {
    expect(
      Value.Check(ImplementationOutcomeSchema, {
        ...common,
        hidden_reasoning: "not durable evidence",
        status: "failed",
      }),
    ).toBe(false);
  });
});

describe("operator questions", () => {
  it("requires the default to be one of the offered options", () => {
    expect(
      validateOperatorQuestion({
        default: "A",
        options: ["A", "B"],
        text: "Choose one",
      }),
    ).toEqual({ ok: true });
    expect(
      validateOperatorQuestion({
        default: "C",
        options: ["A", "B"],
        text: "Choose one",
      }),
    ).toEqual({ ok: false, reason: "question.default_not_in_options" });
  });
});
