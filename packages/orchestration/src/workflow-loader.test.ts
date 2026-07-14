import { describe, expect, it } from "vitest";

import { loadWorkflowFile, parseWorkflowText } from "./workflow-loader.js";

describe("WORKFLOW.md parsing", () => {
  it("parses YAML front matter and a strict prompt body", () => {
    expect(
      parseWorkflowText(`---
tracker:
  kind: github
workspace:
  verify_command: make verify
---
Implement {{ issue.title }} for {{ work_ref }}.
`),
    ).toEqual({
      config: {
        tracker: { kind: "github" },
        workspace: { verify_command: "make verify" },
      },
      prompt: "Implement {{ issue.title }} for {{ work_ref }}.",
      warnings: [],
    });
  });

  it("treats a file without front matter as the prompt", () => {
    expect(parseWorkflowText("Complete {{ system_job.goal }}.\n")).toEqual({
      config: {},
      prompt: "Complete {{ system_job.goal }}.",
      warnings: [],
    });
  });

  it.each([
    ["---\ntracker: [\n---\nprompt", "workflow.front_matter_invalid"],
    ["---\n- tracker\n---\nprompt", "workflow.front_matter_not_map"],
    ["---\ntracker:\n  kind: github\n", "workflow.front_matter_unterminated"],
    ["---\ntracker:\n  kind: github\n---\n   ", "workflow.prompt_empty"],
  ])("rejects malformed workflow input", (source, code) => {
    expect(() => parseWorkflowText(source)).toThrow(code);
  });

  it("rejects bootstrap-only keys in repository configuration", () => {
    expect(() =>
      parseWorkflowText(`---
persistence:
  database_path: ./state.sqlite3
---
Prompt
`),
    ).toThrow("workflow.bootstrap_key_forbidden:persistence.database_path");
  });

  it("rejects safety-critical near misses and warns on forward-compatible unknown keys", () => {
    expect(() =>
      parseWorkflowText(`---
budegt:
  per_issue_usd: 10
---
Prompt
`),
    ).toThrow("workflow.safety_key_near_miss:budegt:budget");
    expect(() =>
      parseWorkflowText(`---
agent:
  max_concurrnt: 4
---
Prompt
`),
    ).toThrow("workflow.safety_key_near_miss:agent.max_concurrnt:agent.max_concurrent");

    expect(
      parseWorkflowText(`---
future_feature:
  enabled: true
---
Prompt
`),
    ).toEqual({
      config: {},
      prompt: "Prompt",
      warnings: ["workflow.unknown_key:future_feature"],
    });
  });

  it("rejects unknown template roots and all filters", () => {
    expect(() => parseWorkflowText("Use {{ repository.name }}.")).toThrow(
      "workflow.template_unknown_variable:repository.name",
    );
    expect(() => parseWorkflowText("Use {{ issue.title | default('none') }}.")).toThrow(
      "workflow.template_filter_forbidden",
    );
  });
});

describe("workflow path precedence", () => {
  it("uses the trusted startup path before the process working directory", async () => {
    const reads: string[] = [];
    const loaded = await loadWorkflowFile({
      cwd: "/service",
      readFile: async (file) => {
        reads.push(file);
        return "Trusted {{ work_ref }}";
      },
      trustedPath: "/operator/custom-workflow.md",
    });

    expect(reads).toEqual(["/operator/custom-workflow.md"]);
    expect(loaded.path).toBe("/operator/custom-workflow.md");
    expect(loaded.prompt).toBe("Trusted {{ work_ref }}");
    expect(loaded.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("falls back to WORKFLOW.md in the process working directory", async () => {
    const loaded = await loadWorkflowFile({
      cwd: "/service",
      readFile: async () => "Default {{ work_ref }}",
    });

    expect(loaded.path).toBe("/service/WORKFLOW.md");
  });

  it("reports the exact missing path", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(
      loadWorkflowFile({
        cwd: "/service",
        readFile: async () => {
          throw missing;
        },
      }),
    ).rejects.toThrow("workflow.file_missing:/service/WORKFLOW.md");
  });
});
