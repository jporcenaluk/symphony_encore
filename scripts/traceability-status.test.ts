import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkTraceabilityStatus,
  inspectTraceabilityStatus,
  parseTraceabilityMatrix,
  renderTraceabilityStatusBlock,
  runTraceabilityStatusCli,
  type TraceabilityCatalog,
  writeTraceabilityStatusBlock,
} from "./traceability-status.js";

const temporaryDirectories: string[] = [];

const ONE_ROW_CATALOG: TraceabilityCatalog = {
  document: "SPEC",
  matrix_file: "docs/compliance/spec-traceability.md",
  registry_sha256: "a".repeat(64),
  requirements: [
    {
      id: "SPEC-R001",
      source: "Purpose, lines 9–10",
      statement: "Preserve `left|right` and escaped pipes.",
      strength: "MUST",
    },
  ],
};

function metadata(
  assessment:
    | { readonly kind: "legacy_mixed"; readonly revision: null }
    | { readonly kind: "exact_revision"; readonly revision: string } = {
    kind: "legacy_mixed",
    revision: null,
  },
): string {
  return `<!-- traceability-metadata ${JSON.stringify({
    assessment,
    document: "SPEC",
    schema_version: 1,
  })} -->`;
}

function matrix(options: { readonly metadata?: string; readonly row?: string } = {}): string {
  return `# SPEC.md traceability matrix

${options.metadata ?? metadata()}

## Traceability matrix

| ID | Source | Strength | Requirement | Status | Implementation paths | Direct evidence | Remaining work | Dependencies | Workstream |
|---|---|---|---|---|---|---|---|---|---|
${
  options.row ??
  "| SPEC-R001 | Purpose, lines 9–10 | MUST | Preserve `left|right` and escaped pipes. | Partial | `src/a.ts` | `rg 'left\\|right' src/a.ts` | Add proof. | None | W0 |"
}

## Assessment summary
`;
}

function semanticDigest(value: unknown): string {
  return createHash("sha256")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex");
}

function defaultMatrixRow(): string {
  const row = matrix().split("\n")[8];
  if (row === undefined) throw new Error("test matrix row missing");
  return row;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-traceability-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "docs/compliance/registry"), { recursive: true });
  for (const file of [
    "SPEC.md",
    "TECH_STACK.md",
    "CICD.md",
    "docs/compliance/registry/spec.requirements.json",
    "docs/compliance/registry/tech-stack.requirements.json",
    "docs/compliance/registry/cicd.requirements.json",
  ]) {
    await copyFile(file, path.join(root, file));
  }
  for (const [file, document] of [
    ["docs/compliance/spec-traceability.md", "SPEC"],
    ["docs/compliance/tech-stack-traceability.md", "TECH_STACK"],
    ["docs/compliance/cicd-traceability.md", "CICD"],
  ] as const) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    const source = await readFile(file, "utf8");
    const marker = `<!-- traceability-metadata ${JSON.stringify({
      assessment: { kind: "legacy_mixed", revision: null },
      document,
      schema_version: 1,
    })} -->`;
    await writeFile(
      path.join(root, file),
      source.includes("<!-- traceability-metadata ")
        ? source
        : source.replace("\n\n", `\n\n${marker}\n\n`),
      "utf8",
    );
  }
  await writeFile(
    path.join(root, "IMPLEMENTATION_STATUS.md"),
    "# Status\n\n<!-- traceability-status:begin -->\nstale\n<!-- traceability-status:end -->\n",
    "utf8",
  );
  return root;
}

async function waitForTemporaryStatusFile(root: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const names = await readdir(root);
    if (names.some((name) => name.startsWith(".IMPLEMENTATION_STATUS.md.traceability-"))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("temporary traceability status file was not observed");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("traceability matrix parser", () => {
  it("parses code-span and escaped pipes without creating extra columns", () => {
    const parsed = parseTraceabilityMatrix(matrix(), ONE_ROW_CATALOG);

    expect(parsed.rows).toEqual([
      {
        dependencies: "None",
        direct_evidence: "`rg 'left|right' src/a.ts`",
        id: "SPEC-R001",
        implementation_paths: "`src/a.ts`",
        remaining_work: "Add proof.",
        requirement: "Preserve `left|right` and escaped pipes.",
        source: "Purpose, lines 9–10",
        status: "Partial",
        strength: "MUST",
        workstream: "W0",
      },
    ]);
    expect(parsed.counts).toEqual({
      external_proof: 0,
      implemented: 0,
      missing: 0,
      partial: 1,
      total: 1,
    });
  });

  it.each([
    ["changed ID", "SPEC-R001", "SPEC-R002", "traceability.spec.row_1.id_mismatch"],
    ["unknown status", "Partial", "partial", "traceability.spec.row_1.status_invalid"],
    [
      "changed source",
      "Purpose, lines 9–10",
      "Purpose, line 9",
      "traceability.spec.row_1.source_mismatch",
    ],
    ["changed strength", "MUST", "SHOULD", "traceability.spec.row_1.strength_mismatch"],
    [
      "changed requirement",
      "Preserve `left|right` and escaped pipes.",
      "Preserve only one pipe.",
      "traceability.spec.row_1.requirement_mismatch",
    ],
    [
      "blank evidence",
      "`rg 'left\\|right' src/a.ts`",
      "",
      "traceability.spec.row_1.direct_evidence_empty",
    ],
  ])("rejects %s", (_name, original, replacement, diagnostic) => {
    expect(() =>
      parseTraceabilityMatrix(
        matrix({ row: defaultMatrixRow().replace(original, replacement) }),
        ONE_ROW_CATALOG,
      ),
    ).toThrow(diagnostic);
  });

  it("rejects invalid assessment metadata unions", () => {
    const invalid = `<!-- traceability-metadata ${JSON.stringify({
      assessment: { kind: "exact_revision", revision: null },
      document: "SPEC",
      schema_version: 1,
    })} -->`;

    expect(() => parseTraceabilityMatrix(matrix({ metadata: invalid }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
  });

  it.each([
    ["short revision", { kind: "exact_revision", revision: "a".repeat(39) }],
    ["uppercase revision", { kind: "exact_revision", revision: "A".repeat(40) }],
    ["legacy revision", { kind: "legacy_mixed", revision: "a".repeat(40) }],
  ])("rejects invalid %s metadata", (_name, assessment) => {
    const invalid = `<!-- traceability-metadata ${JSON.stringify({
      assessment,
      document: "SPEC",
      schema_version: 1,
    })} -->`;
    expect(() => parseTraceabilityMatrix(matrix({ metadata: invalid }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
  });

  it("accepts a syntactically valid exact-revision assessment", () => {
    expect(
      parseTraceabilityMatrix(
        matrix({
          metadata: metadata({ kind: "exact_revision", revision: "a".repeat(40) }),
        }),
        ONE_ROW_CATALOG,
      ).assessment,
    ).toEqual({ kind: "exact_revision", revision: "a".repeat(40) });
  });

  it("rejects duplicate and extra metadata keys", () => {
    const duplicate =
      '<!-- traceability-metadata {"schema_version":1,"document":"SPEC","document":"CICD","assessment":{"kind":"legacy_mixed","revision":null}} -->';
    const extra =
      '<!-- traceability-metadata {"schema_version":1,"document":"SPEC","assessment":{"kind":"legacy_mixed","revision":null},"extra":true} -->';
    expect(() => parseTraceabilityMatrix(matrix({ metadata: duplicate }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
    expect(() => parseTraceabilityMatrix(matrix({ metadata: extra }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
  });

  it("rejects extra indented metadata and malformed JSON with a stable diagnostic", () => {
    const extraRecord = matrix().replace(
      "## Assessment summary",
      `## Assessment summary\n\n ${metadata()}`,
    );
    expect(() => parseTraceabilityMatrix(extraRecord, ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
    expect(() =>
      parseTraceabilityMatrix(
        matrix({
          metadata:
            '<!-- traceability-metadata {"schema_version":1,"document":"SPEC","assessment":{"kind":"legacy_mixed","revision":"\\uZZZZ"}} -->',
        }),
        ONE_ROW_CATALOG,
      ),
    ).toThrow("traceability.spec.metadata_invalid");
  });

  it("requires metadata immediately after the matrix title", () => {
    const misplaced = matrix()
      .replace(`${metadata()}\n\n`, "")
      .replace("## Traceability matrix", `## Traceability matrix\n\n${metadata()}`);

    expect(() => parseTraceabilityMatrix(misplaced, ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.metadata_invalid",
    );
  });

  it("binds the semantic digest to metadata and all ten cells", () => {
    const parsed = parseTraceabilityMatrix(matrix(), ONE_ROW_CATALOG);
    expect(parsed.semantic_matrix_sha256).toBe(
      semanticDigest({
        schema_version: 1,
        document: "SPEC",
        assessment: { kind: "legacy_mixed", revision: null },
        rows: parsed.rows,
      }),
    );
    const changed = parseTraceabilityMatrix(
      matrix({ row: defaultMatrixRow().replace("Add proof.", "Add direct proof.") }),
      ONE_ROW_CATALOG,
    );
    expect(changed.semantic_matrix_sha256).not.toBe(parsed.semantic_matrix_sha256);
  });

  it.each([
    ["status", "Partial", "Missing"],
    ["implementation", "`src/a.ts`", "`src/b.ts`"],
    ["evidence", "`rg 'left\\|right' src/a.ts`", "`test src/a.ts`"],
    ["remaining work", "Add proof.", "Add stronger proof."],
    ["dependencies", "None", "Catalog"],
    ["workstream", "W0", "W1"],
  ])("changes the semantic digest when %s changes", (_name, original, replacement) => {
    const baseline = parseTraceabilityMatrix(matrix(), ONE_ROW_CATALOG);
    const changed = parseTraceabilityMatrix(
      matrix({ row: defaultMatrixRow().replace(original, replacement) }),
      ONE_ROW_CATALOG,
    );
    expect(changed.semantic_matrix_sha256).not.toBe(baseline.semantic_matrix_sha256);
  });

  it("rejects missing, duplicate, and extra rows", () => {
    expect(() => parseTraceabilityMatrix(matrix({ row: "" }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.requirement_count_mismatch",
    );
    const duplicate = `${defaultMatrixRow()}\n${defaultMatrixRow()}`;
    expect(() => parseTraceabilityMatrix(matrix({ row: duplicate }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.row_2.id_unexpected",
    );
    const extra = `${defaultMatrixRow()}\n| SPEC-R999 | Extra | MUST | Extra. | Missing | none | none | none | none | W0 |`;
    expect(() => parseTraceabilityMatrix(matrix({ row: extra }), ONE_ROW_CATALOG)).toThrow(
      "traceability.spec.row_2.id_unexpected",
    );
  });
});

describe("traceability status repository check", () => {
  it("inspects all 761 reviewed rows and current editorial counts", async () => {
    const root = await fixtureRoot();
    const summaries = await inspectTraceabilityStatus(root);

    expect(summaries.map(({ counts, document }) => ({ counts, document }))).toEqual([
      {
        counts: { external_proof: 3, implemented: 54, missing: 28, partial: 242, total: 327 },
        document: "SPEC",
      },
      {
        counts: { external_proof: 18, implemented: 66, missing: 8, partial: 112, total: 204 },
        document: "TECH_STACK",
      },
      {
        counts: { external_proof: 20, implemented: 34, missing: 39, partial: 137, total: 230 },
        document: "CICD",
      },
    ]);
  });

  it("writes only the generated block and is byte-idempotent", async () => {
    const root = await fixtureRoot();
    const before = await readFile(path.join(root, "IMPLEMENTATION_STATUS.md"), "utf8");
    await expect(checkTraceabilityStatus(root)).rejects.toThrow("traceability.status_block_stale");

    await writeTraceabilityStatusBlock(root);
    const first = await readFile(path.join(root, "IMPLEMENTATION_STATUS.md"), "utf8");
    expect(first).not.toBe(before);
    expect(first).toContain("| `SPEC.md` | legacy mixed | — |");
    await expect(checkTraceabilityStatus(root)).resolves.toBeUndefined();

    await writeTraceabilityStatusBlock(root);
    expect(await readFile(path.join(root, "IMPLEMENTATION_STATUS.md"), "utf8")).toBe(first);
  });

  it("rejects symlinked and hard-linked status targets", async () => {
    const root = await fixtureRoot();
    const statusPath = path.join(root, "IMPLEMENTATION_STATUS.md");
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside\n", "utf8");
    await unlink(statusPath);
    await symlink(outside, statusPath);
    await expect(writeTraceabilityStatusBlock(root)).rejects.toThrow(
      "traceability.status_file_invalid",
    );
    expect(await readFile(outside, "utf8")).toBe("outside\n");

    await unlink(statusPath);
    await link(outside, statusPath);
    await expect(writeTraceabilityStatusBlock(root)).rejects.toThrow(
      "traceability.status_file_invalid",
    );
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("rejects oversized input and edits observed before replacement", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs/compliance/spec-traceability.md"),
      "x".repeat(8 * 1024 * 1024 + 1),
      "utf8",
    );
    await expect(inspectTraceabilityStatus(root)).rejects.toThrow(
      "traceability.spec.matrix_size_invalid",
    );

    const secondRoot = await fixtureRoot();
    const statusPath = path.join(secondRoot, "IMPLEMENTATION_STATUS.md");
    const writing = writeTraceabilityStatusBlock(secondRoot);
    await waitForTemporaryStatusFile(secondRoot);
    await appendFile(statusPath, "concurrent edit\n", "utf8");
    await expect(writing).rejects.toThrow("traceability.status_changed");
    expect(await readFile(statusPath, "utf8")).toContain("concurrent edit");

    const thirdRoot = await fixtureRoot();
    const inputPath = path.join(thirdRoot, "docs/compliance/spec-traceability.md");
    const inputWriting = writeTraceabilityStatusBlock(thirdRoot);
    await waitForTemporaryStatusFile(thirdRoot);
    const input = await readFile(inputPath, "utf8");
    await writeFile(inputPath, input.replace("| Partial |", "| Missing |"), "utf8");
    await expect(inputWriting).rejects.toThrow("traceability.inputs_changed");
  });

  it("rejects an exact assessment revision that is not a repository commit", async () => {
    const root = await fixtureRoot();
    const matrixPath = path.join(root, "docs/compliance/spec-traceability.md");
    const source = await readFile(matrixPath, "utf8");
    await writeFile(
      matrixPath,
      source.replace(
        /<!-- traceability-metadata [^\n]+ -->/u,
        metadata({ kind: "exact_revision", revision: "a".repeat(40) }),
      ),
      "utf8",
    );
    await expect(inspectTraceabilityStatus(root)).rejects.toThrow(
      "traceability.spec.assessment_revision_invalid",
    );
  });

  it("renders complete hashes and rejects unsupported CLI arguments", async () => {
    const root = await fixtureRoot();
    const block = renderTraceabilityStatusBlock(await inspectTraceabilityStatus(root));
    expect(block).toMatch(
      /\| `SPEC\.md` \| legacy mixed \| — \| `[a-f0-9]{64}` \| `[a-f0-9]{64}` \|/u,
    );
    await expect(runTraceabilityStatusCli(["--invalid"], root)).resolves.toBe(2);
  });

  it("returns a stable CLI diagnostic when the generated block is stale", async () => {
    const root = await fixtureRoot();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(runTraceabilityStatusCli(["--check"], root)).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith("traceability.status_block_stale\n");
    } finally {
      stderr.mockRestore();
    }
  });

  it("runs from the canonical lint graph", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["traceability:check"]).toBe(
      "node --conditions=development --import ./scripts/typescript-source-loader.mjs scripts/traceability-status-cli.ts --check",
    );
    expect(manifest.scripts["traceability:generate"]).toBe(
      "node --conditions=development --import ./scripts/typescript-source-loader.mjs scripts/traceability-status-cli.ts --write",
    );
    expect(manifest.scripts.lint).toContain("corepack pnpm traceability:check");
  });
});
