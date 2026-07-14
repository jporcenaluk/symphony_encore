import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  hasDuplicateJsonKeys,
  loadReviewedNormativeCatalog,
  type ReviewedNormativeCatalogRequirement,
  readBoundedRegularFile,
} from "./normative-registry.js";

const STATUS_BLOCK_BEGIN = "<!-- traceability-status:begin -->";
const STATUS_BLOCK_END = "<!-- traceability-status:end -->";
const METADATA_PREFIX = "<!-- traceability-metadata ";
const METADATA_SUFFIX = " -->";
const MATRIX_HEADER =
  "| ID | Source | Strength | Requirement | Status | Implementation paths | Direct evidence | Remaining work | Dependencies | Workstream |";
const MATRIX_SEPARATOR = "|---|---|---|---|---|---|---|---|---|---|";
const STATUSES = ["Implemented", "Partial", "Missing", "External proof"] as const;
const MAX_MATRIX_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;

type NormativeDocument = "SPEC" | "TECH_STACK" | "CICD";
type NormativeStrength = "MUST" | "MUST NOT" | "SHOULD";
type TraceabilityStatus = (typeof STATUSES)[number];

export type AssessmentBasis =
  | { readonly kind: "legacy_mixed"; readonly revision: null }
  | { readonly kind: "exact_revision"; readonly revision: string };

export interface TraceabilityCatalogRequirement {
  readonly id: string;
  readonly source: string;
  readonly statement: string;
  readonly strength: NormativeStrength;
}

export interface TraceabilityCatalog {
  readonly document: NormativeDocument;
  readonly matrix_file: string;
  readonly registry_sha256: string;
  readonly requirements: readonly TraceabilityCatalogRequirement[];
}

export interface TraceabilityRow {
  readonly dependencies: string;
  readonly direct_evidence: string;
  readonly id: string;
  readonly implementation_paths: string;
  readonly remaining_work: string;
  readonly requirement: string;
  readonly source: string;
  readonly status: TraceabilityStatus;
  readonly strength: NormativeStrength;
  readonly workstream: string;
}

export interface TraceabilityStatusCounts {
  readonly external_proof: number;
  readonly implemented: number;
  readonly missing: number;
  readonly partial: number;
  readonly total: number;
}

export interface ParsedTraceabilityMatrix {
  readonly assessment: AssessmentBasis;
  readonly counts: TraceabilityStatusCounts;
  readonly document: NormativeDocument;
  readonly rows: readonly TraceabilityRow[];
  readonly semantic_matrix_sha256: string;
}

export interface TraceabilityStatusSummary extends ParsedTraceabilityMatrix {
  readonly matrix_file: string;
  readonly registry_sha256: string;
}

const MATRIX_FILES: Readonly<Record<NormativeDocument, string>> = Object.freeze({
  CICD: "docs/compliance/cicd-traceability.md",
  SPEC: "docs/compliance/spec-traceability.md",
  TECH_STACK: "docs/compliance/tech-stack-traceability.md",
});
const MATRIX_TITLES: Readonly<Record<NormativeDocument, string>> = Object.freeze({
  CICD: "# CICD.md traceability matrix",
  SPEC: "# SPEC.md traceability matrix",
  TECH_STACK: "# TECH_STACK.md traceability matrix",
});

function diagnosticDocument(document: NormativeDocument): string {
  return document.toLowerCase();
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssessment(value: unknown): AssessmentBasis | null {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "revision"])) return null;
  if (value.kind === "legacy_mixed" && value.revision === null) {
    return Object.freeze({ kind: "legacy_mixed", revision: null });
  }
  if (
    value.kind === "exact_revision" &&
    typeof value.revision === "string" &&
    /^[0-9a-f]{40}$/u.test(value.revision)
  ) {
    return Object.freeze({ kind: "exact_revision", revision: value.revision });
  }
  return null;
}

function parseMetadata(text: string, expectedDocument: NormativeDocument): AssessmentBasis {
  const sourceLines = text.split("\n");
  const lines = sourceLines.filter((line) => line.includes("traceability-metadata"));
  const diagnostic = `traceability.${diagnosticDocument(expectedDocument)}.metadata_invalid`;
  if (
    lines.length !== 1 ||
    sourceLines[0] !== MATRIX_TITLES[expectedDocument] ||
    sourceLines[1] !== "" ||
    sourceLines[2] !== lines[0]
  ) {
    throw new Error(diagnostic);
  }
  const line = lines[0];
  if (line === undefined || !line.startsWith(METADATA_PREFIX) || !line.endsWith(METADATA_SUFFIX)) {
    throw new Error(diagnostic);
  }
  let value: unknown;
  const metadataSource = line.slice(METADATA_PREFIX.length, -METADATA_SUFFIX.length);
  try {
    if (hasDuplicateJsonKeys(metadataSource)) throw new Error(diagnostic);
    value = JSON.parse(metadataSource);
  } catch {
    throw new Error(diagnostic);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["assessment", "document", "schema_version"]) ||
    value.schema_version !== 1 ||
    value.document !== expectedDocument
  ) {
    throw new Error(diagnostic);
  }
  const assessment = parseAssessment(value.assessment);
  if (assessment === null) throw new Error(diagnostic);
  return assessment;
}

function splitTableRow(line: string, diagnostic: string): readonly string[] {
  if (!line.startsWith("|") || !line.endsWith("|")) throw new Error(diagnostic);
  const cells: string[] = [];
  let cell = "";
  let codeDelimiterLength: number | null = null;
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") runLength += 1;
      cell += "`".repeat(runLength);
      if (codeDelimiterLength === null) codeDelimiterLength = runLength;
      else if (codeDelimiterLength === runLength) codeDelimiterLength = null;
      index += runLength - 1;
      continue;
    }
    if (character === "|" && codeDelimiterLength === null) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  if (codeDelimiterLength !== null) throw new Error(diagnostic);
  cells.push(cell.trim());
  return cells;
}

function parseRow(
  line: string,
  expected: TraceabilityCatalogRequirement | undefined,
  rowNumber: number,
  document: NormativeDocument,
): TraceabilityRow {
  const prefix = `traceability.${diagnosticDocument(document)}.row_${rowNumber}`;
  const cells = splitTableRow(line, `${prefix}.columns_invalid`);
  if (cells.length !== 10) throw new Error(`${prefix}.columns_invalid`);
  const fieldNames = [
    "id",
    "source",
    "strength",
    "requirement",
    "status",
    "implementation_paths",
    "direct_evidence",
    "remaining_work",
    "dependencies",
    "workstream",
  ] as const;
  for (const [index, field] of fieldNames.entries()) {
    if (cells[index] === "") throw new Error(`${prefix}.${field}_empty`);
  }
  if (expected === undefined) throw new Error(`${prefix}.id_unexpected`);
  if (cells[0] !== expected.id) throw new Error(`${prefix}.id_mismatch`);
  if (cells[1] !== expected.source) throw new Error(`${prefix}.source_mismatch`);
  if (cells[2] !== expected.strength) throw new Error(`${prefix}.strength_mismatch`);
  if (cells[3] !== expected.statement) throw new Error(`${prefix}.requirement_mismatch`);
  if (!STATUSES.includes(cells[4] as TraceabilityStatus)) {
    throw new Error(`${prefix}.status_invalid`);
  }
  return Object.freeze({
    dependencies: cells[8] as string,
    direct_evidence: cells[6] as string,
    id: cells[0] as string,
    implementation_paths: cells[5] as string,
    remaining_work: cells[7] as string,
    requirement: cells[3] as string,
    source: cells[1] as string,
    status: cells[4] as TraceabilityStatus,
    strength: cells[2] as NormativeStrength,
    workstream: cells[9] as string,
  });
}

function countStatuses(rows: readonly TraceabilityRow[]): TraceabilityStatusCounts {
  const counts = { external_proof: 0, implemented: 0, missing: 0, partial: 0 };
  for (const row of rows) {
    if (row.status === "External proof") counts.external_proof += 1;
    else if (row.status === "Implemented") counts.implemented += 1;
    else if (row.status === "Missing") counts.missing += 1;
    else counts.partial += 1;
  }
  return Object.freeze({ ...counts, total: rows.length });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseTraceabilityMatrix(
  source: string,
  catalog: TraceabilityCatalog,
): ParsedTraceabilityMatrix {
  const text = source.replaceAll("\r\n", "\n");
  const assessment = parseMetadata(text, catalog.document);
  const lines = text.split("\n");
  const headerIndexes = lines.flatMap((line, index) => (line === MATRIX_HEADER ? [index] : []));
  const documentDiagnostic = `traceability.${diagnosticDocument(catalog.document)}`;
  if (headerIndexes.length !== 1) throw new Error(`${documentDiagnostic}.table_header_invalid`);
  const headerIndex = headerIndexes[0] as number;
  if (lines[headerIndex + 1] !== MATRIX_SEPARATOR) {
    throw new Error(`${documentDiagnostic}.table_separator_invalid`);
  }
  const rowLines: string[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.startsWith("## ")) break;
    if (line === "") continue;
    if (!line.startsWith("|")) throw new Error(`${documentDiagnostic}.table_content_invalid`);
    rowLines.push(line);
  }
  const rows = Object.freeze(
    rowLines.map((line, index) =>
      parseRow(line, catalog.requirements[index], index + 1, catalog.document),
    ),
  );
  if (rows.length !== catalog.requirements.length) {
    throw new Error(`${documentDiagnostic}.requirement_count_mismatch`);
  }
  const canonical = {
    schema_version: 1 as const,
    document: catalog.document,
    assessment,
    rows,
  };
  return Object.freeze({
    assessment,
    counts: countStatuses(rows),
    document: catalog.document,
    rows,
    semantic_matrix_sha256: sha256(`${JSON.stringify(canonical)}\n`),
  });
}

function catalogForDocument(
  document: NormativeDocument,
  registrySha256: string,
  requirements: readonly ReviewedNormativeCatalogRequirement[],
): TraceabilityCatalog {
  return Object.freeze({
    document,
    matrix_file: MATRIX_FILES[document],
    registry_sha256: registrySha256,
    requirements,
  });
}

function exactRevisionExists(root: string, revision: string): boolean {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      "cat-file",
      "-e",
      `${revision}^{commit}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        FORCE_COLOR: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        NO_COLOR: "1",
      },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
    },
  );
  return result.status === 0 && result.stdout === "" && result.stderr === "";
}

export async function inspectTraceabilityStatus(
  root = process.cwd(),
): Promise<readonly TraceabilityStatusSummary[]> {
  const canonicalRoot = await realpath(root);
  const reviewed = await loadReviewedNormativeCatalog(canonicalRoot);
  return Object.freeze(
    await Promise.all(
      reviewed.documents.map(async (document) => {
        const catalog = catalogForDocument(
          document.document,
          document.registry_sha256,
          document.requirements,
        );
        const parsed = parseTraceabilityMatrix(
          (
            await readBoundedRegularFile(
              canonicalRoot,
              catalog.matrix_file,
              MAX_MATRIX_BYTES,
              `traceability.${diagnosticDocument(document.document)}.matrix`,
            )
          ).toString("utf8"),
          catalog,
        );
        if (
          parsed.assessment.kind === "exact_revision" &&
          !exactRevisionExists(canonicalRoot, parsed.assessment.revision)
        ) {
          throw new Error(
            `traceability.${diagnosticDocument(document.document)}.assessment_revision_invalid`,
          );
        }
        return Object.freeze({
          ...parsed,
          matrix_file: catalog.matrix_file,
          registry_sha256: catalog.registry_sha256,
        });
      }),
    ),
  );
}

function documentFile(document: NormativeDocument): string {
  return document === "TECH_STACK" ? "TECH_STACK.md" : `${document}.md`;
}

export function renderTraceabilityStatusBlock(
  summaries: readonly TraceabilityStatusSummary[],
): string {
  const lines = [
    STATUS_BLOCK_BEGIN,
    "| Document | Assessment basis | Assessed revision | Registry SHA-256 | Semantic matrix SHA-256 | Implemented | Partial | Missing | External proof | Total |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const summary of summaries) {
    const basis = summary.assessment.kind === "legacy_mixed" ? "legacy mixed" : "exact revision";
    const revision =
      summary.assessment.kind === "legacy_mixed" ? "—" : `\`${summary.assessment.revision}\``;
    lines.push(
      `| \`${documentFile(summary.document)}\` | ${basis} | ${revision} | \`${summary.registry_sha256}\` | \`${summary.semantic_matrix_sha256}\` | ${summary.counts.implemented} | ${summary.counts.partial} | ${summary.counts.missing} | ${summary.counts.external_proof} | ${summary.counts.total} |`,
    );
  }
  lines.push(STATUS_BLOCK_END);
  return lines.join("\n");
}

function locateStatusBlock(text: string): { readonly end: number; readonly start: number } {
  const start = text.indexOf(STATUS_BLOCK_BEGIN);
  const secondStart = text.indexOf(STATUS_BLOCK_BEGIN, start + STATUS_BLOCK_BEGIN.length);
  const endMarker = text.indexOf(STATUS_BLOCK_END);
  const secondEnd = text.indexOf(STATUS_BLOCK_END, endMarker + STATUS_BLOCK_END.length);
  if (start < 0 || endMarker < 0 || endMarker < start || secondStart >= 0 || secondEnd >= 0) {
    throw new Error("traceability.status_block_invalid");
  }
  return { end: endMarker + STATUS_BLOCK_END.length, start };
}

async function expectedStatusBlock(root: string): Promise<string> {
  return renderTraceabilityStatusBlock(await inspectTraceabilityStatus(root));
}

async function readStatusFile(root: string): Promise<Buffer> {
  return readBoundedRegularFile(
    root,
    "IMPLEMENTATION_STATUS.md",
    MAX_STATUS_BYTES,
    "traceability.status",
  );
}

export async function checkTraceabilityStatus(root = process.cwd()): Promise<void> {
  const canonicalRoot = await realpath(root);
  const text = (await readStatusFile(canonicalRoot)).toString("utf8");
  const bounds = locateStatusBlock(text);
  if (text.slice(bounds.start, bounds.end) !== (await expectedStatusBlock(canonicalRoot))) {
    throw new Error("traceability.status_block_stale");
  }
}

export async function writeTraceabilityStatusBlock(root = process.cwd()): Promise<void> {
  const canonicalRoot = await realpath(root);
  const statusPath = path.join(canonicalRoot, "IMPLEMENTATION_STATUS.md");
  const before = await lstat(statusPath).catch(() => undefined);
  if (before === undefined || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("traceability.status_file_invalid");
  }
  const original = await readStatusFile(canonicalRoot);
  const text = original.toString("utf8");
  const bounds = locateStatusBlock(text);
  const expected = await expectedStatusBlock(canonicalRoot);
  const next = `${text.slice(0, bounds.start)}${expected}${text.slice(bounds.end)}`;
  if (next === text) return;

  const temporaryPath = path.join(
    canonicalRoot,
    `.IMPLEMENTATION_STATUS.md.traceability-${process.pid}-${Date.now()}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      before.mode & 0o777,
    );
    await handle.writeFile(next, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (expected !== (await expectedStatusBlock(canonicalRoot))) {
      throw new Error("traceability.inputs_changed");
    }
    // Preserve crash atomicity and reject any edit visible before replacement. POSIX does not
    // provide compare-and-swap for path contents, so callers must serialize this write with other
    // editors; the generated check remains the authoritative non-mutating CI operation.
    const current = await lstat(statusPath).catch(() => undefined);
    const currentContent = await readStatusFile(canonicalRoot).catch(() => undefined);
    if (
      current === undefined ||
      currentContent === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mode !== before.mode ||
      !currentContent.equals(original)
    ) {
      throw new Error("traceability.status_changed");
    }
    await rename(temporaryPath, statusPath);
    renamed = true;
    const directory = await open(canonicalRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function runTraceabilityStatusCli(
  args: readonly string[],
  root = process.cwd(),
): Promise<number> {
  if (args.length !== 1 || !["--check", "--write"].includes(args[0] ?? "")) return 2;
  try {
    if (args[0] === "--write") {
      await writeTraceabilityStatusBlock(root);
      process.stdout.write("traceability status: generated block updated\n");
    } else {
      await checkTraceabilityStatus(root);
      process.stdout.write("traceability status: 761 requirements checked\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "traceability.status_invalid"}\n`,
    );
    return 1;
  }
}
