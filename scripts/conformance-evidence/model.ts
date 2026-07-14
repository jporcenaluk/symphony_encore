import {
  CORE_CONFORMANCE_MANIFEST,
  type CoreAdapterKind,
  type CoreConformanceId,
  type CorePlatform,
} from "../../packages/contracts/src/index.ts";

export const EVIDENCE_PRODUCER_VERSION = "symphony-conformance-evidence/1" as const;

export interface EvidenceSuiteRequirement {
  readonly id: CoreConformanceId;
  readonly required_adapter_kinds: readonly CoreAdapterKind[];
  readonly required_platforms: readonly CorePlatform[];
  readonly requirement_sha256: string;
}

export interface UnmappedEvidenceSuite extends EvidenceSuiteRequirement {
  readonly diagnostic: string;
  readonly mapping: "unmapped";
}

export type CoreEvidenceSuite = UnmappedEvidenceSuite;

export interface TrustedSuiteResult extends EvidenceSuiteRequirement {
  readonly diagnostic: string;
  readonly id: CoreConformanceId;
  readonly mapping: "unmapped";
  readonly status: "unmapped";
}

export interface TrustedEvidenceRun {
  readonly artifact_digest: `sha256:${string}`;
  readonly complete: false;
  readonly diagnostics: readonly string[];
  readonly kind: "trusted_core_evidence_run";
  readonly producer_version: typeof EVIDENCE_PRODUCER_VERSION;
  readonly revision: string | null;
  readonly schema_version: "1";
  readonly source_date_epoch: number | null;
  readonly suite_results: readonly TrustedSuiteResult[];
}

function recursivelyFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) recursivelyFreeze(child);
  return Object.freeze(value);
}

export const CORE_EVIDENCE_SUITES: readonly CoreEvidenceSuite[] = recursivelyFreeze(
  CORE_CONFORMANCE_MANIFEST.map((manifest) => ({
    diagnostic: `evidence.suite.unmapped:${manifest.id}`,
    id: manifest.id,
    mapping: "unmapped" as const,
    required_adapter_kinds: [...manifest.required_adapter_kinds],
    required_platforms: [...manifest.required_platforms],
    requirement_sha256: manifest.requirement_sha256,
  })),
);

export function unmappedSuiteResults(): readonly TrustedSuiteResult[] {
  return CORE_EVIDENCE_SUITES.map((suite) => ({
    diagnostic: suite.diagnostic,
    id: suite.id,
    mapping: "unmapped",
    required_adapter_kinds: [...suite.required_adapter_kinds],
    required_platforms: [...suite.required_platforms],
    requirement_sha256: suite.requirement_sha256,
    status: "unmapped",
  }));
}

export function freezeEvidenceRun(run: TrustedEvidenceRun): TrustedEvidenceRun {
  return recursivelyFreeze(run);
}
