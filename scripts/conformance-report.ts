import {
  CORE_CONFORMANCE_IDS,
  EXTERNAL_EVIDENCE_IDS,
  NORMATIVE_DOCUMENTS,
  REAL_INTEGRATION_CASE_IDS,
} from "../packages/contracts/src/index.ts";
import { isTrustedEvidenceRun } from "./conformance-evidence.js";

const SELECTED_ADAPTER_KINDS = ["tracker", "repository_host", "agent", "authentication"] as const;

export interface BuildConformanceReportInput {
  readonly commandDiagnostics?: readonly string[];
  readonly evidence: unknown;
  readonly implementationVersion: string | null;
}

export function generatedAtFromSourceEpoch(sourceDateEpoch: number | null): string | null {
  if (sourceDateEpoch === null || !Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    return null;
  }
  const value = new Date(sourceDateEpoch * 1000);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/**
 * This reporter intentionally has no success path yet. The trusted producer currently exposes
 * the exact Core inventory as unmapped, and exhaustive normative, adapter, Real Integration, and
 * external registries do not yet exist. Future success must replace the individual unproven gates
 * with validators; it must not weaken this fail-closed aggregate.
 */
export function buildConformanceReport(input: BuildConformanceReportInput) {
  const trusted = isTrustedEvidenceRun(input.evidence);
  const evidence = trusted ? input.evidence : null;
  const diagnostics = [
    ...(trusted ? (evidence?.diagnostics ?? []) : ["conformance.evidence.unavailable"]),
    ...(input.commandDiagnostics ?? []),
  ];
  const missingCoreIds = [...CORE_CONFORMANCE_IDS];
  const unmappedCoreIds = [...CORE_CONFORMANCE_IDS];

  return {
    adapters: SELECTED_ADAPTER_KINDS.map((kind) => ({
      evidence: null,
      implementation: null,
      kind,
      status: "unproven" as const,
      version: null,
    })),
    core_conformance: false as const,
    enabled_extensions: [],
    generated_at: generatedAtFromSourceEpoch(evidence?.source_date_epoch ?? null),
    implementation: {
      name: "symphony-encore",
      revision: evidence?.revision ?? null,
      version: input.implementationVersion,
    },
    implementation_defined_choices: [
      "single configured project per service instance",
      "local SQLite in WAL mode",
      "loopback-only first-run bootstrap",
      "supervised learning synthesis",
    ],
    production_ready: false as const,
    results: {
      core_evidence: {
        artifact_digest: evidence?.artifact_digest ?? null,
        complete: false as const,
        diagnostics,
        producer_version: evidence?.producer_version ?? null,
        status: trusted ? ("incomplete" as const) : ("rejected" as const),
        trusted,
      },
      deterministic: {
        completed_ids: [],
        missing_ids: missingCoreIds,
        status: "incomplete" as const,
        unmapped_ids: unmappedCoreIds,
      },
      external: {
        completed_ids: [],
        missing_ids: [...EXTERNAL_EVIDENCE_IDS],
        status: "unproven" as const,
      },
      normative_coverage: {
        documents: [...NORMATIVE_DOCUMENTS],
        status: "unproven" as const,
      },
      real_integration: {
        completed_ids: [],
        missing_ids: [...REAL_INTEGRATION_CASE_IDS],
        status: "not_run" as const,
      },
      selected_adapters: {
        completed_kinds: [],
        missing_kinds: [...SELECTED_ADAPTER_KINDS],
        status: "unproven" as const,
      },
    },
    schema_version: 1,
    specifications: [
      { document: "SPEC.md", status: "Draft v3" },
      { document: "TECH_STACK.md", status: "Draft v1" },
      { document: "CICD.md", status: "Draft v1" },
    ],
    test_command: "make conformance",
  };
}

export type ConformanceReport = ReturnType<typeof buildConformanceReport>;

function formatJson(value: unknown, depth: number, column: number): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("conformance.report_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const primitive = value.every(
      (item) => item === null || ["boolean", "number", "string"].includes(typeof item),
    );
    if (primitive) {
      const inline = `[${value.map((item) => formatJson(item, depth + 1, 0)).join(", ")}]`;
      if (column + inline.length <= 100) return inline;
    }
    const itemIndent = "  ".repeat(depth + 1);
    const closingIndent = "  ".repeat(depth);
    return `[\n${value
      .map((item) => `${itemIndent}${formatJson(item, depth + 1, itemIndent.length)}`)
      .join(",\n")}\n${closingIndent}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const propertyIndent = "  ".repeat(depth + 1);
    const closingIndent = "  ".repeat(depth);
    return `{\n${entries
      .map(([key, child]) => {
        const prefix = `${propertyIndent}${JSON.stringify(key)}: `;
        return `${prefix}${formatJson(child, depth + 1, prefix.length)}`;
      })
      .join(",\n")}\n${closingIndent}}`;
  }
  throw new Error("conformance.report_value_invalid");
}

export function serializeConformanceReport(report: ConformanceReport): string {
  return `${formatJson(report, 0, 0)}\n`;
}
