import { createHash } from "node:crypto";
import path from "node:path";

export interface EvidenceTestSelector {
  readonly file: string;
  readonly full_name: string;
}

interface ParsedVitestArtifact {
  readonly argv: readonly string[];
  readonly producer_version: string;
  readonly selectors: readonly EvidenceTestSelector[];
  readonly tests: readonly (EvidenceTestSelector & { readonly status: "passed" })[];
}

export type ParsedVitestResult =
  | {
      readonly artifact: ParsedVitestArtifact;
      readonly artifact_digest: `sha256:${string}`;
      readonly ok: true;
      readonly observed_tests: readonly string[];
    }
  | { readonly diagnostics: readonly string[]; readonly ok: false };

export interface ParseVitestExpectation {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly producerVersion: string;
  readonly repositoryRoot: string;
  readonly selectors: readonly EvidenceTestSelector[];
}

interface VitestAssertionResult {
  readonly fullName: string;
  readonly status: string;
}

interface VitestFileResult {
  readonly assertionResults: readonly VitestAssertionResult[];
  readonly name: string;
  readonly status: string;
}

interface VitestJsonResult {
  readonly numFailedTests: number;
  readonly numPassedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly numTotalTests: number;
  readonly success: boolean;
  readonly testResults: readonly VitestFileResult[];
}

interface VitestEnvelope {
  readonly argv: readonly string[];
  readonly producer_version: string;
  readonly selectors: readonly EvidenceTestSelector[];
  readonly vitest: VitestJsonResult;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("evidence.canonical.non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodeUnits)
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("evidence.canonical.unsupported_value");
}

export function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function selectorsFrom(value: unknown): readonly EvidenceTestSelector[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selectors: EvidenceTestSelector[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.file !== "string" ||
      candidate.file.length === 0 ||
      typeof candidate.full_name !== "string" ||
      candidate.full_name.length === 0
    ) {
      return undefined;
    }
    selectors.push({ file: candidate.file, full_name: candidate.full_name });
  }
  return selectors;
}

function vitestResultFrom(value: unknown): VitestJsonResult | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.numFailedTests) ||
    !Number.isSafeInteger(value.numPassedTests) ||
    !Number.isSafeInteger(value.numPendingTests) ||
    !Number.isSafeInteger(value.numTodoTests) ||
    !Number.isSafeInteger(value.numTotalTests) ||
    typeof value.success !== "boolean" ||
    !Array.isArray(value.testResults)
  ) {
    return undefined;
  }
  const counts = [
    value.numFailedTests,
    value.numPassedTests,
    value.numPendingTests,
    value.numTodoTests,
    value.numTotalTests,
  ] as number[];
  if (counts.some((count) => count < 0)) return undefined;
  const testResults: VitestFileResult[] = [];
  for (const fileResult of value.testResults) {
    if (
      !isRecord(fileResult) ||
      typeof fileResult.name !== "string" ||
      typeof fileResult.status !== "string" ||
      !Array.isArray(fileResult.assertionResults)
    ) {
      return undefined;
    }
    const assertionResults: VitestAssertionResult[] = [];
    for (const assertion of fileResult.assertionResults) {
      if (
        !isRecord(assertion) ||
        typeof assertion.fullName !== "string" ||
        typeof assertion.status !== "string"
      ) {
        return undefined;
      }
      assertionResults.push({ fullName: assertion.fullName, status: assertion.status });
    }
    testResults.push({ assertionResults, name: fileResult.name, status: fileResult.status });
  }
  return {
    numFailedTests: value.numFailedTests as number,
    numPassedTests: value.numPassedTests as number,
    numPendingTests: value.numPendingTests as number,
    numTodoTests: value.numTodoTests as number,
    numTotalTests: value.numTotalTests as number,
    success: value.success,
    testResults,
  };
}

function envelopeFrom(rawArtifact: string): VitestEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(rawArtifact) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const argv = isStringArray(value.argv) ? value.argv : undefined;
  const selectors = selectorsFrom(value.selectors);
  const vitest = vitestResultFrom(value.vitest);
  if (
    argv === undefined ||
    selectors === undefined ||
    vitest === undefined ||
    typeof value.producer_version !== "string"
  ) {
    return undefined;
  }
  return { argv, producer_version: value.producer_version, selectors, vitest };
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function selectorKey(selector: EvidenceTestSelector): string {
  return `${selector.file}\u0000${selector.full_name}`;
}

function equalSelectorSets(
  left: readonly EvidenceTestSelector[],
  right: readonly EvidenceTestSelector[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(selectorKey).sort(compareCodeUnits);
  const rightKeys = right.map(selectorKey).sort(compareCodeUnits);
  return (
    equalStringArrays(leftKeys, rightKeys) &&
    new Set(leftKeys).size === leftKeys.length &&
    new Set(rightKeys).size === rightKeys.length
  );
}

function normalizeObservedFile(
  observed: string,
  expectedFiles: readonly string[],
  repositoryRoot: string,
): string | undefined {
  const normalizedObserved = observed.replaceAll("\\", "/");
  const normalizedRoot = path.resolve(repositoryRoot).replaceAll("\\", "/");
  const matches = expectedFiles.filter((file) => {
    const normalizedFile = file.replaceAll("\\", "/");
    if (
      path.isAbsolute(file) ||
      normalizedFile !== path.posix.normalize(normalizedFile) ||
      normalizedFile.startsWith("../")
    ) {
      return false;
    }
    return (
      normalizedObserved === normalizedFile ||
      normalizedObserved === `${normalizedRoot}/${normalizedFile}`
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseVitestResult(
  rawArtifact: string,
  expectation: ParseVitestExpectation,
): ParsedVitestResult {
  const envelope = envelopeFrom(rawArtifact);
  if (envelope === undefined) return { diagnostics: ["evidence.vitest.schema_invalid"], ok: false };
  if (envelope.producer_version !== expectation.producerVersion) {
    return { diagnostics: ["evidence.vitest.producer_drift"], ok: false };
  }
  if (!equalStringArrays(envelope.argv, expectation.argv)) {
    return { diagnostics: ["evidence.vitest.argv_drift"], ok: false };
  }
  if (!equalSelectorSets(envelope.selectors, expectation.selectors)) {
    return { diagnostics: ["evidence.vitest.selector_drift"], ok: false };
  }
  if (expectation.exitCode !== 0) {
    return { diagnostics: ["evidence.vitest.nonzero_exit"], ok: false };
  }

  const vitest = envelope.vitest;
  if (vitest.numTotalTests === 0 || vitest.testResults.length === 0) {
    return { diagnostics: ["evidence.vitest.zero_tests"], ok: false };
  }
  if (
    vitest.numPassedTests + vitest.numFailedTests + vitest.numPendingTests + vitest.numTodoTests !==
    vitest.numTotalTests
  ) {
    return { diagnostics: ["evidence.vitest.counter_sum_drift"], ok: false };
  }
  if (
    vitest.numPendingTests > 0 ||
    vitest.numTodoTests > 0 ||
    vitest.testResults.some(
      (file) =>
        file.status === "skipped" ||
        file.assertionResults.some((assertion) =>
          ["pending", "skipped", "todo"].includes(assertion.status),
        ),
    )
  ) {
    return { diagnostics: ["evidence.vitest.skipped"], ok: false };
  }
  if (
    vitest.numFailedTests > 0 ||
    !vitest.success ||
    vitest.testResults.some(
      (file) =>
        file.status !== "passed" ||
        file.assertionResults.some((assertion) => assertion.status !== "passed"),
    )
  ) {
    return { diagnostics: ["evidence.vitest.failed"], ok: false };
  }
  const expectedFiles = expectation.selectors.map((selector) => selector.file);
  const observed: Array<EvidenceTestSelector & { status: "passed" }> = [];
  for (const fileResult of vitest.testResults) {
    const file = normalizeObservedFile(fileResult.name, expectedFiles, expectation.repositoryRoot);
    if (file === undefined) {
      return { diagnostics: ["evidence.vitest.observed_selectors"], ok: false };
    }
    for (const assertion of fileResult.assertionResults) {
      observed.push({ file, full_name: assertion.fullName, status: "passed" });
    }
  }
  if (!equalSelectorSets(observed, expectation.selectors)) {
    return { diagnostics: ["evidence.vitest.observed_selectors"], ok: false };
  }
  if (observed.length !== vitest.numPassedTests) {
    return { diagnostics: ["evidence.vitest.observed_count_drift"], ok: false };
  }

  const artifact = Object.freeze({
    argv: Object.freeze([...expectation.argv]),
    producer_version: expectation.producerVersion,
    selectors: Object.freeze(
      expectation.selectors.map((selector) => Object.freeze({ ...selector })),
    ),
    tests: Object.freeze(
      observed
        .sort((left, right) => compareCodeUnits(selectorKey(left), selectorKey(right)))
        .map((test) => Object.freeze({ ...test })),
    ),
  });
  return {
    artifact,
    artifact_digest: digestCanonical(artifact),
    observed_tests: Object.freeze(artifact.tests.map((test) => test.full_name)),
    ok: true,
  };
}
