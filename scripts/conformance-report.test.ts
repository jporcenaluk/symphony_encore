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
import { loadReviewedNormativeRegistry } from "./normative-registry.js";

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
      normativeRegistry: {
        documents: [],
        kind: "reviewed_normative_registry",
        schema_version: 1,
        total_requirements: 761,
      },
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
    expect(report.normative_registry).toEqual({
      diagnostic: "conformance.normative_registry.unavailable",
      documents: [],
      status: "unavailable",
      total_requirements: null,
    });
  });

  it("reports every trusted but unmapped Core case as missing", async () => {
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const normativeRegistry = await loadReviewedNormativeRegistry();
    const report = buildConformanceReport({
      evidence,
      implementationVersion: "0.0.0",
      normativeRegistry,
    });

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
    expect(report.normative_registry).toEqual({
      diagnostic: null,
      documents: normativeRegistry.documents,
      status: "validated_identity",
      total_requirements: 761,
    });
    expect(report.results.normative_coverage.status).toBe("unproven");
    expect(report.schema_version).toBe(2);
    expect(report.specifications).toEqual([
      {
        document: "SPEC.md",
        registry_sha256: "d3344f5bbd0f1400e9437cbdcfcd94fe02b28b83c523b9efcad9ddc823a76f2e",
        source_sha256: "e247f8f1c634d7d1b02e84ca48b557264aa34b66323ece1698fc6e867812df23",
        status: "Draft v3",
      },
      {
        document: "TECH_STACK.md",
        registry_sha256: "ef3aabad4de329ee68108410d59f21bf73c67cd209651c88684c6345c615eb46",
        source_sha256: "edcfcfa293c4346e479458d127903e6435ab7a0f9373a7e166b64c3a8442b4c6",
        status: "Draft v1",
      },
      {
        document: "CICD.md",
        registry_sha256: "046f32c7a2a93296136c15d7b6e4395055fc9a5a6e49d7b8338e19e2641800ce",
        source_sha256: "55e7cd08c5c9d0300077423fead4c29bf1fb14fd8610b3ca85e8d60ce9c151bd",
        status: "Draft v1",
      },
    ]);
  });

  it("does not accept replayed reviewed-registry capabilities", async () => {
    const normativeRegistry = await loadReviewedNormativeRegistry();
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const first = buildConformanceReport({
      evidence,
      implementationVersion: "0.0.0",
      normativeRegistry,
    });
    const replay = buildConformanceReport({
      evidence,
      implementationVersion: "0.0.0",
      normativeRegistry,
    });

    expect(first.normative_registry.status).toBe("validated_identity");
    expect(replay.normative_registry).toEqual({
      diagnostic: "conformance.normative_registry.unavailable",
      documents: [],
      status: "unavailable",
      total_requirements: null,
    });
  });

  it("derives its timestamp from the immutable source epoch", () => {
    expect(generatedAtFromSourceEpoch(1_767_225_600)).toBe("2026-01-01T00:00:00.000Z");
    expect(generatedAtFromSourceEpoch(null)).toBeNull();
    expect(generatedAtFromSourceEpoch(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("keeps normative, adapter, real-integration, and external gates unproven", async () => {
    const evidence = await produceTrustedEvidence(await privateDirectory());
    const report = buildConformanceReport({
      evidence,
      implementationVersion: "0.0.0",
      normativeRegistry: await loadReviewedNormativeRegistry(),
    });

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
    const firstRegistry = await loadReviewedNormativeRegistry();
    const secondRegistry = await loadReviewedNormativeRegistry();
    const first = serializeConformanceReport(
      buildConformanceReport({
        evidence,
        implementationVersion: "0.0.0",
        normativeRegistry: firstRegistry,
      }),
    );
    const second = serializeConformanceReport(
      buildConformanceReport({
        evidence,
        implementationVersion: "0.0.0",
        normativeRegistry: secondRegistry,
      }),
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
