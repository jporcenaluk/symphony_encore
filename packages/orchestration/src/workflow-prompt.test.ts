import { describe, expect, it } from "vitest";

import { renderWorkflowPrompt } from "./workflow-prompt.js";

const context = {
  attempt: { attempt_number: 2, role: "implementation" },
  change_class: "standard",
  issue: {
    acceptance_criteria: ["Tests pass", "Docs updated"],
    title: "Render the workflow prompt",
  },
  plan: null,
  rules: "1. Verify before completion.",
  system_job: null,
  work_ref: "issue:issue-7",
} as const;

describe("workflow prompt rendering", () => {
  it("renders every documented root and nested scalar values", () => {
    expect(
      renderWorkflowPrompt(
        "{{ work_ref }} | {{ issue.title }} | {{ attempt.attempt_number }} | {{ change_class }} | {{ plan }} | {{ rules }} | {{ system_job }}",
        context,
      ),
    ).toBe(
      "issue:issue-7 | Render the workflow prompt | 2 | standard | null | 1. Verify before completion. | null",
    );
  });

  it("serializes arrays and objects deterministically without HTML escaping", () => {
    expect(renderWorkflowPrompt("{{ issue.acceptance_criteria }}\n{{ issue }}", context)).toBe(
      '["Tests pass","Docs updated"]\n{"acceptance_criteria":["Tests pass","Docs updated"],"title":"Render the workflow prompt"}',
    );
  });

  it.each([
    ["{{ issue.missing }}", "workflow.template_unknown_variable:issue.missing"],
    ["{{ repository.name }}", "workflow.template_unknown_variable:repository.name"],
    ["{{ issue.title | upper }}", "workflow.template_filter_forbidden"],
    ["{{ issue.__proto__ }}", "workflow.template_unsafe_variable:issue.__proto__"],
    ["{{ issue..title }}", "workflow.template_unknown_variable:issue..title"],
    ["{{ issue.title", "workflow.template_unterminated"],
  ])("fails closed for an invalid expression", (template, code) => {
    expect(() => renderWorkflowPrompt(template, context)).toThrow(code);
  });

  it("rejects undefined and non-finite rendered values", () => {
    expect(() =>
      renderWorkflowPrompt("{{ issue.title }}", {
        ...context,
        issue: { title: undefined },
      }),
    ).toThrow("workflow.template_unknown_variable:issue.title");
    expect(() =>
      renderWorkflowPrompt("{{ attempt.elapsed }}", {
        ...context,
        attempt: { elapsed: Number.POSITIVE_INFINITY },
      }),
    ).toThrow("workflow.template_value_invalid:attempt.elapsed");
  });

  it("fails closed in linear time for adversarial repeated interpolation prefixes", () => {
    const hostile = "{{{{a".repeat(100_000);

    expect(() => renderWorkflowPrompt(hostile, context)).toThrow("workflow.template_unterminated");
  });
});
