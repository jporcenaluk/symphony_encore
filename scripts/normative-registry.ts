import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const LINE_MARKER_PATTERN = /\blines?\s+/u;
const NUMBER_RANGE_PATTERN = /^(\d+)(?:[–-](\d+))?$/u;
const STRENGTHS = ["MUST", "MUST NOT", "SHOULD"] as const;
const KINDS = ["leaf", "aggregate", "profile", "reference"] as const;
const APPLICABILITY = ["required", "exception_allowed"] as const;

interface DocumentContract {
  readonly document: "SPEC" | "TECH_STACK" | "CICD";
  readonly file: string;
  readonly prefix: string;
  readonly registry: string;
  readonly registrySha256: string;
  readonly requirementCount: number;
  readonly sourceSha256: string;
  readonly status: string;
  readonly strengths: Readonly<Record<NormativeStrength, number>>;
}

export interface ReviewedNormativeDocument {
  readonly document: "SPEC" | "TECH_STACK" | "CICD";
  readonly registry_file: string;
  readonly registry_sha256: string;
  readonly requirement_count: number;
  readonly source_file: string;
  readonly source_sha256: string;
  readonly status: string;
  readonly strengths: Readonly<Record<NormativeStrength, number>>;
}

export interface ReviewedNormativeRegistry {
  readonly documents: readonly ReviewedNormativeDocument[];
  readonly kind: "reviewed_normative_registry";
  readonly schema_version: 1;
  readonly total_requirements: number;
}

export interface ReviewedNormativeCatalogRequirement {
  readonly id: string;
  readonly source: string;
  readonly statement: string;
  readonly strength: NormativeStrength;
}

export interface ReviewedNormativeCatalogDocument {
  readonly document: "SPEC" | "TECH_STACK" | "CICD";
  readonly registry_sha256: string;
  readonly requirements: readonly ReviewedNormativeCatalogRequirement[];
}

export interface ReviewedNormativeCatalog {
  readonly documents: readonly ReviewedNormativeCatalogDocument[];
  readonly kind: "reviewed_normative_catalog";
  readonly schema_version: 1;
  readonly total_requirements: number;
}

type NormativeStrength = (typeof STRENGTHS)[number];
type RequirementKind = (typeof KINDS)[number];
type Applicability = (typeof APPLICABILITY)[number];

interface NormativeRequirement {
  readonly applicability: Applicability;
  readonly id: string;
  readonly kind: RequirementKind;
  readonly members: readonly string[];
  readonly source: string;
  readonly source_fragment_sha256: string;
  readonly statement: string;
  readonly strength: NormativeStrength;
}

interface ValidatedNormativeDocument {
  readonly catalog: ReviewedNormativeCatalogDocument;
  readonly summary: ReviewedNormativeDocument;
}

const DOCUMENTS: readonly DocumentContract[] = [
  {
    document: "SPEC",
    file: "SPEC.md",
    prefix: "SPEC-R",
    registry: "docs/compliance/registry/spec.requirements.json",
    registrySha256: "d3344f5bbd0f1400e9437cbdcfcd94fe02b28b83c523b9efcad9ddc823a76f2e",
    requirementCount: 327,
    sourceSha256: "e247f8f1c634d7d1b02e84ca48b557264aa34b66323ece1698fc6e867812df23",
    status: "Draft v3",
    strengths: { MUST: 291, "MUST NOT": 34, SHOULD: 2 },
  },
  {
    document: "TECH_STACK",
    file: "TECH_STACK.md",
    prefix: "STACK-R",
    registry: "docs/compliance/registry/tech-stack.requirements.json",
    registrySha256: "ef3aabad4de329ee68108410d59f21bf73c67cd209651c88684c6345c615eb46",
    requirementCount: 204,
    sourceSha256: "edcfcfa293c4346e479458d127903e6435ab7a0f9373a7e166b64c3a8442b4c6",
    status: "Draft v1",
    strengths: { MUST: 147, "MUST NOT": 46, SHOULD: 11 },
  },
  {
    document: "CICD",
    file: "CICD.md",
    prefix: "CICD-R",
    registry: "docs/compliance/registry/cicd.requirements.json",
    registrySha256: "046f32c7a2a93296136c15d7b6e4395055fc9a5a6e49d7b8338e19e2641800ce",
    requirementCount: 230,
    sourceSha256: "55e7cd08c5c9d0300077423fead4c29bf1fb14fd8610b3ca85e8d60ce9c151bd",
    status: "Draft v1",
    strengths: { MUST: 165, "MUST NOT": 33, SHOULD: 32 },
  },
] as const;

const REVIEWED_REGISTRIES = new WeakSet<object>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readBoundedRegularFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  diagnosticPrefix: string,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const canonicalRoot = await realpath(root);
    const target = path.resolve(canonicalRoot, relativePath);
    if (!target.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("invalid");
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error("invalid");
    }
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = await handle.stat({ bigint: false });
    if (
      !held.isFile() ||
      held.nlink !== 1 ||
      held.dev !== before.dev ||
      held.ino !== before.ino ||
      !Number.isSafeInteger(held.size) ||
      held.size < 1
    ) {
      throw new Error("invalid");
    }
    if (held.size > maximumBytes) throw new Error(`${diagnosticPrefix}_size_invalid`);
    if ((await realpath(target)) !== target) throw new Error("invalid");

    const content = Buffer.alloc(held.size);
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.read(content, offset, content.length - offset, offset);
      if (result.bytesRead === 0) throw new Error("invalid");
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraRead = await handle.read(extra, 0, 1, content.length);
    const after = await handle.stat({ bigint: false });
    const current = await lstat(target);
    if (
      extraRead.bytesRead !== 0 ||
      after.size !== held.size ||
      after.dev !== held.dev ||
      after.ino !== held.ino ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw new Error("invalid");
    }
    return content;
  } catch (error) {
    if ((error as Error).message === `${diagnosticPrefix}_size_invalid`) throw error;
    throw new Error(`${diagnosticPrefix}_file_invalid`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function hasDuplicateJsonKeys(source: string): boolean {
  let offset = 0;
  let duplicate = false;

  const whitespace = () => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    return "";
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      while (source[offset] !== "}" && offset < source.length) {
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        offset += 1;
        value();
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      while (source[offset] !== "]" && offset < source.length) {
        value();
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset] ?? "")) offset += 1;
  };

  whitespace();
  value();
  return duplicate;
}

function record(value: unknown, diagnostic: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(diagnostic);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  diagnostic: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(diagnostic);
  }
}

function requiredString(value: unknown, diagnostic: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(diagnostic);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  diagnostic: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(diagnostic);
  return value as T[number];
}

export function sourceFragmentForReference(
  sourceText: string,
  sourceReference: string,
  diagnostic = "normative.registry.source_lines_invalid",
): string {
  const lines = sourceText.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line.length > 0) ?? [];
  const marker = LINE_MARKER_PATTERN.exec(sourceReference);
  if (marker === null) throw new Error(diagnostic);
  const rangeSources = sourceReference.slice(marker.index + marker[0].length).split(" and ");
  if (rangeSources.length === 0 || rangeSources.some((range) => range.length === 0)) {
    throw new Error(diagnostic);
  }
  const fragments: string[] = [];
  let previousEnd = 0;
  for (const rangeSource of rangeSources) {
    const range = NUMBER_RANGE_PATTERN.exec(rangeSource);
    if (range === null) throw new Error(diagnostic);
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      start <= previousEnd ||
      end > lines.length
    ) {
      throw new Error(diagnostic);
    }
    fragments.push(lines.slice(start - 1, end).join(""));
    previousEnd = end;
  }
  return fragments.join("");
}

function parseRequirement(
  value: unknown,
  contract: DocumentContract,
  sourceText: string,
  index: number,
): NormativeRequirement {
  const diagnostic = `normative.registry.${contract.document.toLowerCase()}.requirement_${index + 1}`;
  const input = record(value, `${diagnostic}.invalid`);
  exactKeys(
    input,
    [
      "applicability",
      "id",
      "kind",
      "members",
      "source",
      "source_fragment_sha256",
      "statement",
      "strength",
    ],
    `${diagnostic}.fields_invalid`,
  );
  const id = requiredString(input.id, `${diagnostic}.id_invalid`);
  const expectedId = `${contract.prefix}${String(index + 1).padStart(3, "0")}`;
  if (id !== expectedId) throw new Error(`${diagnostic}.id_invalid`);
  const source = requiredString(input.source, `${diagnostic}.source_invalid`);
  const statement = requiredString(input.statement, `${diagnostic}.statement_invalid`);
  const strength = enumValue(input.strength, STRENGTHS, `${diagnostic}.strength_invalid`);
  const kind = enumValue(input.kind, KINDS, `${diagnostic}.kind_invalid`);
  const applicability = enumValue(
    input.applicability,
    APPLICABILITY,
    `${diagnostic}.applicability_invalid`,
  );
  if (strength !== "SHOULD" && applicability !== "required") {
    throw new Error(`${diagnostic}.applicability_invalid`);
  }
  if (!Array.isArray(input.members) || input.members.some((member) => typeof member !== "string")) {
    throw new Error(`${diagnostic}.members_invalid`);
  }
  const members = input.members as string[];
  if (new Set(members).size !== members.length || members.includes(id)) {
    throw new Error(`${diagnostic}.members_invalid`);
  }
  if (kind === "aggregate" && members.length === 0) {
    throw new Error(`${diagnostic}.aggregate_members_missing`);
  }
  if (kind === "leaf" && members.length > 0) {
    throw new Error(`${diagnostic}.leaf_members_invalid`);
  }
  const fragmentDigest = requiredString(
    input.source_fragment_sha256,
    `${diagnostic}.source_fragment_sha256_invalid`,
  );
  if (!/^[a-f0-9]{64}$/u.test(fragmentDigest)) {
    throw new Error(`${diagnostic}.source_fragment_sha256_invalid`);
  }
  if (
    sha256(sourceFragmentForReference(sourceText, source, `${diagnostic}.source_lines_invalid`)) !==
    fragmentDigest
  ) {
    throw new Error(`${diagnostic}.source_fragment_sha256_mismatch`);
  }
  return {
    applicability,
    id,
    kind,
    members,
    source,
    source_fragment_sha256: fragmentDigest,
    statement,
    strength,
  };
}

function assertAcyclic(requirements: readonly NormativeRequirement[], document: string): void {
  const members = new Map(requirements.map((requirement) => [requirement.id, requirement.members]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`normative.registry.${document}.membership_cycle`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const member of members.get(id) ?? []) visit(member);
    visiting.delete(id);
    visited.add(id);
  };
  for (const requirement of requirements) visit(requirement.id);
}

async function validateRegistry(
  root: string,
  contract: DocumentContract,
): Promise<ValidatedNormativeDocument> {
  const [sourceBuffer, registryBuffer] = await Promise.all([
    readBoundedRegularFile(
      root,
      contract.file,
      MAX_SOURCE_BYTES,
      `normative.registry.${contract.document.toLowerCase()}.source`,
    ),
    readBoundedRegularFile(
      root,
      contract.registry,
      MAX_REGISTRY_BYTES,
      `normative.registry.${contract.document.toLowerCase()}.registry`,
    ),
  ]);
  const sourceText = sourceBuffer.toString("utf8").replaceAll("\r\n", "\n");
  const sourceDigest = sha256(sourceBuffer);
  if (sourceDigest !== contract.sourceSha256) {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.source_version_unknown`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(registryBuffer.toString("utf8"));
  } catch {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.json_invalid`);
  }
  if (hasDuplicateJsonKeys(registryBuffer.toString("utf8"))) {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.json_duplicate_key`);
  }
  const input = record(parsed, `normative.registry.${contract.document.toLowerCase()}.invalid`);
  exactKeys(
    input,
    ["document", "file", "requirements", "schema_version", "source_sha256", "status"],
    `normative.registry.${contract.document.toLowerCase()}.fields_invalid`,
  );
  if (
    input.schema_version !== 1 ||
    input.document !== contract.document ||
    input.file !== contract.file ||
    input.status !== contract.status ||
    input.source_sha256 !== contract.sourceSha256
  ) {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.metadata_invalid`);
  }
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length !== contract.requirementCount
  ) {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.count_invalid`);
  }
  const requirements = input.requirements.map((requirement, index) =>
    parseRequirement(requirement, contract, sourceText, index),
  );
  const ids = new Set(requirements.map((requirement) => requirement.id));
  for (const requirement of requirements) {
    if (requirement.members.some((member) => !ids.has(member))) {
      throw new Error(`normative.registry.${contract.document.toLowerCase()}.member_unknown`);
    }
  }
  assertAcyclic(requirements, contract.document.toLowerCase());
  const strengths: Record<NormativeStrength, number> = { MUST: 0, "MUST NOT": 0, SHOULD: 0 };
  for (const requirement of requirements) strengths[requirement.strength] += 1;
  if (STRENGTHS.some((strength) => strengths[strength] !== contract.strengths[strength])) {
    throw new Error(`normative.registry.${contract.document.toLowerCase()}.strength_count_invalid`);
  }
  if (sha256(registryBuffer) !== contract.registrySha256) {
    throw new Error(
      `normative.registry.${contract.document.toLowerCase()}.registry_digest_mismatch`,
    );
  }
  return Object.freeze({
    catalog: Object.freeze({
      document: contract.document,
      registry_sha256: contract.registrySha256,
      requirements: Object.freeze(
        requirements.map((requirement) =>
          Object.freeze({
            id: requirement.id,
            source: requirement.source,
            statement: requirement.statement,
            strength: requirement.strength,
          }),
        ),
      ),
    }),
    summary: Object.freeze({
      document: contract.document,
      registry_file: contract.registry,
      registry_sha256: contract.registrySha256,
      requirement_count: requirements.length,
      source_file: contract.file,
      source_sha256: contract.sourceSha256,
      status: contract.status,
      strengths: Object.freeze({ ...contract.strengths }),
    }),
  });
}

async function validateDocuments(root: string): Promise<readonly ValidatedNormativeDocument[]> {
  return Object.freeze(
    await Promise.all(DOCUMENTS.map((document) => validateRegistry(root, document))),
  );
}

export async function loadReviewedNormativeRegistry(
  root = process.cwd(),
): Promise<ReviewedNormativeRegistry> {
  const documents = Object.freeze((await validateDocuments(root)).map(({ summary }) => summary));
  const registry = Object.freeze({
    documents,
    kind: "reviewed_normative_registry" as const,
    schema_version: 1 as const,
    total_requirements: documents.reduce(
      (total, document) => total + document.requirement_count,
      0,
    ),
  });
  REVIEWED_REGISTRIES.add(registry);
  return registry;
}

export async function loadReviewedNormativeCatalog(
  root = process.cwd(),
): Promise<ReviewedNormativeCatalog> {
  const documents = Object.freeze((await validateDocuments(root)).map(({ catalog }) => catalog));
  return Object.freeze({
    documents,
    kind: "reviewed_normative_catalog" as const,
    schema_version: 1 as const,
    total_requirements: documents.reduce(
      (total, document) => total + document.requirements.length,
      0,
    ),
  });
}

export function isReviewedNormativeRegistry(value: unknown): value is ReviewedNormativeRegistry {
  return typeof value === "object" && value !== null && REVIEWED_REGISTRIES.has(value);
}

export function consumeReviewedNormativeRegistry(
  value: unknown,
): value is ReviewedNormativeRegistry {
  if (!isReviewedNormativeRegistry(value)) return false;
  REVIEWED_REGISTRIES.delete(value);
  return true;
}

export async function validateNormativeRegistry(root = process.cwd()): Promise<number> {
  return (await loadReviewedNormativeRegistry(root)).total_requirements;
}

export async function runNormativeRegistryCli(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== "--check") return 2;
  try {
    const count = await validateNormativeRegistry();
    process.stdout.write(`normative registry: ${count} requirements validated\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "normative.registry.invalid"}\n`,
    );
    return 1;
  }
}
