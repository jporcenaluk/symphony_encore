import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_CONFORMANCE_IDS,
  EXTERNAL_EVIDENCE_IDS,
  REAL_INTEGRATION_CASE_IDS,
} from "../packages/contracts/src/index.ts";

import { produceTrustedEvidence } from "./conformance-evidence.js";
import {
  buildConformanceReport,
  generatedAtFromSourceEpoch,
  serializeConformanceReport,
} from "./conformance-report.js";

const temporaryDirectories: string[] = [];

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-report-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("fail-closed conformance report", () => {
  it("rejects manually authored evidence even when it claims completion", () => {
    const report = buildConformanceReport({
      evidence: {
        artifact_digest: "sha256:forged",
        complete: true,
        diagnostics: ["forged.diagnostic"],
        producer_version: "forged",
        revision: "0123456789abcdef0123456789abcdef01234567",
        source_date_epoch: 1_767_225_600,
        suite_results: CORE_CONFORMANCE_IDS.map((id) => ({ id, status: "passed" })),
      },
      implementationVersion: "0.0.0",
    });

    expect(report.core_conformance).toBe(false);
    expect(report.production_ready).toBe(false);
    expect(report.results.core_evidence).toMatchObject({
      artifact_digest: null,
      diagnostics: ["conformance.evidence.unavailable"],
      producer_version: null,
      status: "rejected",
      trusted: false,
    });
    expect(report.generated_at).toBeNull();
    expect(report.implementation.revision).toBeNull();
    expect(report.results.deterministic.completed_ids).toEqual([]);
    expect(report.results.deterministic.missing_ids).toEqual(CORE_CONFORMANCE_IDS);
  });

  it("reports every trusted but unmapped Core case as missing", async () => {
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const report = buildConformanceReport({ evidence, implementationVersion: "0.0.0" });

    expect(report.core_conformance).toBe(false);
    expect(report.production_ready).toBe(false);
    expect(report.results.core_evidence).toMatchObject({
      complete: false,
      status: "incomplete",
      trusted: true,
    });
    expect(report.results.deterministic).toEqual({
      completed_ids: [],
      missing_ids: CORE_CONFORMANCE_IDS,
      status: "incomplete",
      unmapped_ids: CORE_CONFORMANCE_IDS,
    });
  });

  it("derives its timestamp from the immutable source epoch", () => {
    expect(generatedAtFromSourceEpoch(1_767_225_600)).toBe("2026-01-01T00:00:00.000Z");
    expect(generatedAtFromSourceEpoch(null)).toBeNull();
    expect(generatedAtFromSourceEpoch(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("keeps normative, adapter, real-integration, and external gates unproven", async () => {
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const report = buildConformanceReport({ evidence, implementationVersion: "0.0.0" });

    expect(report.adapters.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "tracker", status: "unproven" },
      { kind: "repository_host", status: "unproven" },
      { kind: "agent", status: "unproven" },
      { kind: "authentication", status: "unproven" },
    ]);
    expect(report.results.normative_coverage).toEqual({
      documents: ["SPEC", "TECH_STACK", "CICD"],
      status: "unproven",
    });
    expect(report.results.selected_adapters.status).toBe("unproven");
    expect(report.results.real_integration).toEqual({
      completed_ids: [],
      missing_ids: REAL_INTEGRATION_CASE_IDS,
      status: "not_run",
    });
    expect(report.results.external).toEqual({
      completed_ids: [],
      missing_ids: EXTERNAL_EVIDENCE_IDS,
      status: "unproven",
    });
  });

  it("serializes the same evidence to byte-identical repository-formatted JSON", async () => {
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const first = serializeConformanceReport(
      buildConformanceReport({ evidence, implementationVersion: "0.0.0" }),
    );
    const second = serializeConformanceReport(
      buildConformanceReport({ evidence, implementationVersion: "0.0.0" }),
    );

    expect(second).toBe(first);
    const reportPath = path.join(await privateDirectory(), "core.json");
    await writeFile(reportPath, first, "utf8");
    const formatCheck = spawnSync("corepack", ["pnpm", "exec", "biome", "check", reportPath], {
      encoding: "utf8",
      env: process.env,
      shell: false,
    });
    expect(formatCheck.status, `${formatCheck.stdout}${formatCheck.stderr}`).toBe(0);
  });
});
