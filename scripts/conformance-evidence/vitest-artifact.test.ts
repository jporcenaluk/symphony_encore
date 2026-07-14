import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_PRODUCER_VERSION } from "./model.js";
import { digestCanonical, parseVitestResult } from "./vitest-artifact.js";

const selectors = [
  {
    file: "packages/persistence/src/dispatch-store.test.ts",
    full_name: "dispatch store acquires atomically",
  },
] as const;
const argv = ["node", "/trusted/vitest.mjs", "run", selectors[0].file] as const;

interface ArtifactOverrides {
  readonly assertionStatus?: string;
  readonly argv?: readonly string[];
  readonly failed?: number;
  readonly fileStatus?: string;
  readonly observedFile?: string;
  readonly observedFullName?: string;
  readonly passed?: number;
  readonly pending?: number;
  readonly producerVersion?: string;
  readonly selectors?: readonly { readonly file: string; readonly full_name: string }[];
  readonly success?: boolean;
  readonly todo?: number;
  readonly total?: number;
}

function artifact(overrides: ArtifactOverrides = {}): string {
  const total = overrides.total ?? 1;
  const failed = overrides.failed ?? 0;
  const pending = overrides.pending ?? 0;
  const todo = overrides.todo ?? 0;
  const passed = overrides.passed ?? total - failed - pending - todo;
  return JSON.stringify({
    argv: overrides.argv ?? argv,
    producer_version: overrides.producerVersion ?? EVIDENCE_PRODUCER_VERSION,
    selectors: overrides.selectors ?? selectors,
    vitest: {
      numFailedTests: failed,
      numPassedTests: passed,
      numPendingTests: pending,
      numTodoTests: todo,
      numTotalTests: total,
      success: overrides.success ?? failed === 0,
      testResults:
        total === 0
          ? []
          : [
              {
                assertionResults: [
                  {
                    fullName: overrides.observedFullName ?? selectors[0].full_name,
                    status: overrides.assertionStatus ?? "passed",
                  },
                ],
                name: overrides.observedFile ?? path.join(process.cwd(), selectors[0].file),
                status: overrides.fileStatus ?? "passed",
              },
            ],
    },
  });
}

function parse(raw = artifact(), exitCode = 0) {
  return parseVitestResult(raw, {
    argv,
    exitCode,
    producerVersion: EVIDENCE_PRODUCER_VERSION,
    repositoryRoot: process.cwd(),
    selectors,
  });
}

describe("Vitest artifact parser", () => {
  it("accepts the exact producer, argv, selectors, counters, and observations", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observed_tests).toEqual([selectors[0].full_name]);
  });

  it.each([
    ["invalid JSON", "{", "evidence.vitest.schema_invalid"],
    ["producer drift", artifact({ producerVersion: "other" }), "evidence.vitest.producer_drift"],
    [
      "argv drift",
      artifact({ argv: [...argv, "--passWithNoTests"] }),
      "evidence.vitest.argv_drift",
    ],
    [
      "selector drift",
      artifact({ selectors: [{ file: selectors[0].file, full_name: "forged" }] }),
      "evidence.vitest.selector_drift",
    ],
    ["zero tests", artifact({ total: 0 }), "evidence.vitest.zero_tests"],
    ["pending counter", artifact({ passed: 0, pending: 1 }), "evidence.vitest.skipped"],
    ["todo counter", artifact({ passed: 0, todo: 1 }), "evidence.vitest.skipped"],
    ["pending assertion", artifact({ assertionStatus: "pending" }), "evidence.vitest.skipped"],
    ["skipped assertion", artifact({ assertionStatus: "skipped" }), "evidence.vitest.skipped"],
    ["todo assertion", artifact({ assertionStatus: "todo" }), "evidence.vitest.skipped"],
    ["skipped file", artifact({ fileStatus: "skipped" }), "evidence.vitest.skipped"],
    ["failed counter", artifact({ failed: 1, passed: 0, success: true }), "evidence.vitest.failed"],
    ["false success", artifact({ success: false }), "evidence.vitest.failed"],
    ["file failure", artifact({ fileStatus: "failed" }), "evidence.vitest.failed"],
    ["assertion failure", artifact({ assertionStatus: "failed" }), "evidence.vitest.failed"],
    [
      "counter sum drift",
      artifact({ failed: 1, passed: 1, total: 1 }),
      "evidence.vitest.counter_sum_drift",
    ],
    [
      "observed count drift",
      artifact({ passed: 2, total: 2 }),
      "evidence.vitest.observed_count_drift",
    ],
    [
      "observed name drift",
      artifact({ observedFullName: "another test" }),
      "evidence.vitest.observed_selectors",
    ],
    [
      "observed file outside root",
      artifact({ observedFile: `/untrusted/${selectors[0].file}` }),
      "evidence.vitest.observed_selectors",
    ],
  ])("rejects %s", (_label, raw, diagnostic) => {
    expect(parse(raw)).toEqual({ diagnostics: [diagnostic], ok: false });
  });

  it("rejects a nonzero exit independently of otherwise passing JSON", () => {
    expect(parse(artifact(), 1)).toEqual({
      diagnostics: ["evidence.vitest.nonzero_exit"],
      ok: false,
    });
  });

  it("rejects negative, fractional, and inconsistent counters", () => {
    expect(parse(artifact({ passed: -1, total: -1 }))).toMatchObject({
      diagnostics: ["evidence.vitest.schema_invalid"],
    });
    const fractional = JSON.parse(artifact()) as { vitest: { numPassedTests: number } };
    fractional.vitest.numPassedTests = 0.5;
    expect(parse(JSON.stringify(fractional))).toMatchObject({
      diagnostics: ["evidence.vitest.schema_invalid"],
    });
    expect(parse(artifact({ failed: 1, passed: 1, success: true, total: 1 }))).toMatchObject({
      diagnostics: ["evidence.vitest.counter_sum_drift"],
    });
  });

  it("rejects duplicate expected or observed selectors", () => {
    const duplicateExpected = parseVitestResult(artifact(), {
      argv,
      exitCode: 0,
      producerVersion: EVIDENCE_PRODUCER_VERSION,
      repositoryRoot: process.cwd(),
      selectors: [selectors[0], selectors[0]],
    });
    expect(duplicateExpected.ok).toBe(false);

    const duplicateObserved = JSON.parse(artifact()) as {
      vitest: { numPassedTests: number; numTotalTests: number; testResults: unknown[] };
    };
    duplicateObserved.vitest.numPassedTests = 2;
    duplicateObserved.vitest.numTotalTests = 2;
    duplicateObserved.vitest.testResults.push(duplicateObserved.vitest.testResults[0]);
    expect(parse(JSON.stringify(duplicateObserved))).toMatchObject({
      diagnostics: ["evidence.vitest.observed_selectors"],
    });
  });

  it("changes the digest when behavioral content changes and ignores object key order", () => {
    expect(digestCanonical({ a: 1, b: 2 })).toBe(digestCanonical({ b: 2, a: 1 }));
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: 2 }));
    const first = parse();
    const second = parseVitestResult(
      artifact({
        observedFullName: "different behavior",
        selectors: [{ ...selectors[0], full_name: "different behavior" }],
      }),
      {
        argv,
        exitCode: 0,
        producerVersion: EVIDENCE_PRODUCER_VERSION,
        repositoryRoot: process.cwd(),
        selectors: [{ ...selectors[0], full_name: "different behavior" }],
      },
    );
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.artifact_digest).not.toBe(second.artifact_digest);
  });

  it("recursively freezes parsed observations and returned selector names", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.artifact.tests)).toBe(true);
    expect(Object.isFrozen(result.artifact.tests[0])).toBe(true);
    expect(Object.isFrozen(result.artifact.selectors)).toBe(true);
    expect(Object.isFrozen(result.artifact.selectors[0])).toBe(true);
    expect(Object.isFrozen(result.observed_tests)).toBe(true);
  });
});
