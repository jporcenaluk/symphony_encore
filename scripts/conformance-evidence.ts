import {
  EVIDENCE_PRODUCER_VERSION,
  freezeEvidenceRun,
  type TrustedEvidenceRun,
  unmappedSuiteResults,
} from "./conformance-evidence/model.js";
import {
  closePrivateArtifactStore,
  openPrivateArtifactStore,
  publishPrivateArtifact,
} from "./conformance-evidence/private-artifact-store.js";
import {
  captureRepositorySnapshot,
  changedRepositorySnapshot,
  snapshotsMatch,
} from "./conformance-evidence/repository-snapshot.js";
import { digestCanonical } from "./conformance-evidence/vitest-artifact.js";

export {
  CORE_EVIDENCE_SUITES,
  EVIDENCE_PRODUCER_VERSION,
  type TrustedEvidenceRun,
} from "./conformance-evidence/model.js";
export {
  type EvidenceTestSelector,
  type ParsedVitestResult,
  type ParseVitestExpectation,
  parseVitestResult,
} from "./conformance-evidence/vitest-artifact.js";

const ARTIFACT_NAME = "core-evidence-run.json";
const TRUSTED_RUNS = new WeakSet<object>();

export async function produceTrustedEvidence(
  privateDirectory: string,
): Promise<TrustedEvidenceRun> {
  const store = await openPrivateArtifactStore(privateDirectory);
  try {
    const repositoryBefore = await captureRepositorySnapshot();

    // All Core cases remain deliberately unmapped. Mapped evidence requires a future
    // immutable HEAD/tree-bound runner plus hosted attestation; this producer cannot run tests.
    const suiteResults = unmappedSuiteResults();
    const repositoryAfter =
      repositoryBefore.diagnostics.length === 0
        ? await captureRepositorySnapshot()
        : repositoryBefore;
    const repository = snapshotsMatch(repositoryBefore, repositoryAfter)
      ? repositoryBefore
      : repositoryBefore.diagnostics.length > 0
        ? repositoryBefore
        : changedRepositorySnapshot();
    const suiteDiagnostics = suiteResults.map((result) => result.diagnostic);
    const payload = {
      complete: false as const,
      diagnostics: repository.diagnostics.length > 0 ? repository.diagnostics : suiteDiagnostics,
      kind: "trusted_core_evidence_run" as const,
      producer_version: EVIDENCE_PRODUCER_VERSION,
      revision: repository.revision,
      schema_version: "1" as const,
      source_date_epoch: repository.sourceDateEpoch,
      suite_results: suiteResults,
    };
    const run = freezeEvidenceRun({ ...payload, artifact_digest: digestCanonical(payload) });
    const serialized = Buffer.from(`${JSON.stringify(run, null, 2)}\n`, "utf8");
    await publishPrivateArtifact(store, ARTIFACT_NAME, serialized);
    TRUSTED_RUNS.add(run);
    return run;
  } finally {
    await closePrivateArtifactStore(store).catch(() => undefined);
  }
}

/**
 * Only an object produced in this invocation is trusted. The persisted artifact is private,
 * bounded, and crash-atomic diagnostic output—not same-UID attestation. Mapped Core evidence
 * still requires an immutable tree-bound runner and hosted attestation.
 */
export function isTrustedEvidenceRun(value: unknown): value is TrustedEvidenceRun {
  return typeof value === "object" && value !== null && TRUSTED_RUNS.has(value);
}
