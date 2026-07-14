import { describe, expect, it } from "vitest";
import {
  CORE_CONFORMANCE_IDS,
  CORE_CONFORMANCE_MANIFEST,
} from "../../packages/contracts/src/index.ts";
import { CORE_EVIDENCE_SUITES, unmappedSuiteResults } from "./model.js";

describe("Core evidence model", () => {
  it("contains all 35 manifest entries exactly once and only as unmapped", () => {
    expect(CORE_EVIDENCE_SUITES).toHaveLength(35);
    expect(CORE_EVIDENCE_SUITES.map((suite) => suite.id)).toEqual(CORE_CONFORMANCE_IDS);
    expect(new Set(CORE_EVIDENCE_SUITES.map((suite) => suite.id)).size).toBe(35);
    expect(CORE_EVIDENCE_SUITES).toEqual(
      CORE_CONFORMANCE_MANIFEST.map((entry) => ({
        diagnostic: `evidence.suite.unmapped:${entry.id}`,
        id: entry.id,
        mapping: "unmapped",
        required_adapter_kinds: entry.required_adapter_kinds,
        required_platforms: entry.required_platforms,
        requirement_sha256: entry.requirement_sha256,
      })),
    );
  });

  it("can only create unmapped suite results without execution evidence", () => {
    const results = unmappedSuiteResults();
    expect(results).toHaveLength(35);
    expect(results.every((result) => result.mapping === "unmapped")).toBe(true);
    expect(results.every((result) => result.status === "unmapped")).toBe(true);
    expect(results.every((result) => !("execution" in result))).toBe(true);
  });

  it("recursively freezes the exported registry and its nested requirement arrays", () => {
    expect(Object.isFrozen(CORE_EVIDENCE_SUITES)).toBe(true);
    expect(Object.isFrozen(CORE_EVIDENCE_SUITES[0])).toBe(true);
    expect(Object.isFrozen(CORE_EVIDENCE_SUITES[0]?.required_adapter_kinds)).toBe(true);
    expect(Object.isFrozen(CORE_EVIDENCE_SUITES[0]?.required_platforms)).toBe(true);
  });
});
