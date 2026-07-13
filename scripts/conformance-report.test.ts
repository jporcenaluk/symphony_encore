import { describe, expect, it } from "vitest";

import {
  buildConformanceReport,
  readCoreMatrix,
  specificationRequirementsComplete,
} from "./conformance-report.ts";

describe("Core conformance report", () => {
  it("requires all nineteen specification areas to be implemented", () => {
    const implemented = Array.from(
      { length: 19 },
      (_, index) => `| S${String(index + 1).padStart(2, "0")} | Area | Implemented | Proof |`,
    ).join("\n");
    expect(specificationRequirementsComplete(implemented)).toBe(true);
    expect(
      specificationRequirementsComplete(implemented.replace("Implemented", "In progress")),
    ).toBe(false);
  });

  it("extracts complete and missing proof IDs from the implementation ledger", () => {
    expect(
      readCoreMatrix(`
- [x] \`C-WF-01\` Workflow proof.
- [ ] \`C-WF-02\` Override proof.
- [x] \`C-DUR-01\` Atomic proof.
`),
    ).toEqual({
      completed: ["C-WF-01", "C-DUR-01"],
      missing: ["C-WF-02"],
    });
  });

  it("reports partial coverage as incomplete rather than Core Conformance", () => {
    expect(
      buildConformanceReport({
        generatedAt: "2026-07-13T12:00:00Z",
        implementationVersion: "0.0.0",
        matrix: { completed: ["C-WF-01"], missing: ["C-WF-02"] },
        requirementsComplete: false,
        revision: "abc1234",
      }),
    ).toMatchObject({
      adapters: [
        { kind: "tracker", name: "github", status: "partial", version: "0.0.0" },
        { kind: "repository_host", name: "github", status: "partial", version: "0.0.0" },
        { kind: "agent", name: "codex_app_server", status: "contract_only", version: "0.0.0" },
        { kind: "authentication", name: "local", status: "implemented", version: "0.0.0" },
      ],
      core_conformance: false,
      implementation: { name: "symphony-encore", revision: "abc1234", version: "0.0.0" },
      results: {
        deterministic: {
          completed_ids: ["C-WF-01"],
          missing_ids: ["C-WF-02"],
          status: "incomplete",
        },
        real_integration: { report: null, status: "not_run" },
      },
      spec: { document: "SPEC.md", status: "Draft v3" },
      test_command: "make conformance",
    });
  });

  it("separates Core Conformance from the production-ready Real Integration requirement", () => {
    const report = buildConformanceReport({
      generatedAt: "2026-07-13T12:00:00Z",
      implementationVersion: "1.0.0",
      matrix: { completed: ["C-WF-01"], missing: [] },
      requirementsComplete: true,
      revision: "abc1234",
    });

    expect(report.core_conformance).toBe(true);
    expect(report.production_ready).toBe(false);
    expect(report.results.deterministic.status).toBe("passed");
    expect(report.results.real_integration.status).toBe("not_run");
  });
});
