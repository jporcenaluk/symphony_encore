import {
  copyFile,
  mkdir,
  mkdtemp,
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
  runNormativeRegistryCli,
  sourceFragmentForReference,
  validateNormativeRegistry,
} from "./normative-registry.js";

const temporaryDirectories: string[] = [];

interface MutableRequirement extends Record<string, unknown> {
  applicability: unknown;
  id: unknown;
  kind: unknown;
  members: unknown;
  source_fragment_sha256: unknown;
  statement: unknown;
  strength: unknown;
}

interface MutableRegistry extends Record<string, unknown> {
  requirements: MutableRequirement[];
  status: unknown;
}

function mutableRequirement(registry: MutableRegistry, index: number): MutableRequirement {
  const requirement = registry.requirements[index];
  if (requirement === undefined) throw new Error(`fixture requirement ${index} missing`);
  return requirement;
}

async function registryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-normative-registry-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "docs/compliance/registry"), { recursive: true });
  await Promise.all(
    [
      "SPEC.md",
      "TECH_STACK.md",
      "CICD.md",
      "docs/compliance/registry/spec.requirements.json",
      "docs/compliance/registry/tech-stack.requirements.json",
      "docs/compliance/registry/cicd.requirements.json",
    ].map(async (file) => copyFile(file, path.join(root, file))),
  );
  return root;
}

async function mutateRegistry(
  root: string,
  name: "spec" | "tech-stack" | "cicd",
  mutation: (registry: MutableRegistry) => void,
): Promise<void> {
  const registryPath = path.join(root, `docs/compliance/registry/${name}.requirements.json`);
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as MutableRegistry;
  mutation(registry);
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`, "utf8");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("normative requirement registry", () => {
  it("hashes every disjoint line range in textual order", () => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\n";
    expect(sourceFragmentForReference(source, "§3, lines 2–3 and 5–6")).toBe(
      "two\nthree\nfive\nsix\n",
    );
  });

  it.each([
    "§3, lines 5–6 and 2–3",
    "§3, lines 2–4 and 3–5",
    "§3, lines 2–3 garbage 5",
    "§3, lines 2–3 and",
  ])("rejects malformed or non-increasing source ranges: %s", (reference) => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\n";
    expect(() => sourceFragmentForReference(source, reference)).toThrow(
      "normative.registry.source_lines_invalid",
    );
  });

  it("retains the source's actual final-line terminator", () => {
    expect(sourceFragmentForReference("one\ntwo", "lines 2")).toBe("two");
    expect(sourceFragmentForReference("one\ntwo\n", "lines 2")).toBe("two\n");
  });

  it("runs from the canonical lint graph without rewriting registries", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["normative:check"]).toBe(
      "node --conditions=development --import ./scripts/typescript-source-loader.mjs scripts/normative-registry-cli.ts --check",
    );
    expect(manifest.scripts["normative:cli-check"]).toBe(
      "node --conditions=development --import ./scripts/typescript-source-loader.mjs scripts/verify-normative-registry-cli.ts",
    );
    expect(manifest.scripts.lint).toContain("corepack pnpm normative:cli-check");
    expect(manifest.scripts.lint).toContain("corepack pnpm normative:check");
  });

  it("validates every source-bound normative requirement", async () => {
    await expect(validateNormativeRegistry()).resolves.toBe(761);
  });

  it("rejects a whitespace-only normative statement", async () => {
    const root = await registryFixture();
    const registryPath = path.join(root, "docs/compliance/registry/spec.requirements.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      requirements: Array<{ statement: string }>;
    };
    const first = registry.requirements[0];
    if (first === undefined) throw new Error("fixture requirement missing");
    first.statement = "   ";
    await writeFile(registryPath, `${JSON.stringify(registry)}\n`, "utf8");

    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.requirement_1.statement_invalid",
    );
  });

  it.each([
    [
      "unknown registry fields",
      (registry: MutableRegistry) => {
        registry.unexpected = true;
      },
      "normative.registry.spec.fields_invalid",
    ],
    [
      "unknown fields",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).unexpected = true;
      },
      "normative.registry.spec.requirement_1.fields_invalid",
    ],
    [
      "non-contiguous IDs",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).id = "SPEC-R002";
      },
      "normative.registry.spec.requirement_1.id_invalid",
    ],
    [
      "unknown strength",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).strength = "MAY";
      },
      "normative.registry.spec.requirement_1.strength_invalid",
    ],
    [
      "unknown kind",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).kind = "umbrella";
      },
      "normative.registry.spec.requirement_1.kind_invalid",
    ],
    [
      "MUST exception applicability",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).applicability = "exception_allowed";
      },
      "normative.registry.spec.requirement_1.applicability_invalid",
    ],
    [
      "non-array members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).members = "SPEC-R002";
      },
      "normative.registry.spec.requirement_1.members_invalid",
    ],
    [
      "non-string members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).members = [1];
      },
      "normative.registry.spec.requirement_1.members_invalid",
    ],
    [
      "duplicate members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 49).members = ["SPEC-R051", "SPEC-R051"];
      },
      "normative.registry.spec.requirement_50.members_invalid",
    ],
    [
      "self members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 49).members = ["SPEC-R050"];
      },
      "normative.registry.spec.requirement_50.members_invalid",
    ],
    [
      "unknown members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 49).members = ["SPEC-R999"];
      },
      "normative.registry.spec.member_unknown",
    ],
    [
      "empty aggregate",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 49).members = [];
      },
      "normative.registry.spec.requirement_50.aggregate_members_missing",
    ],
    [
      "leaf members",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).members = ["SPEC-R002"];
      },
      "normative.registry.spec.requirement_1.leaf_members_invalid",
    ],
    [
      "invalid fragment digest",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).source_fragment_sha256 = "invalid";
      },
      "normative.registry.spec.requirement_1.source_fragment_sha256_invalid",
    ],
    [
      "mismatched fragment digest",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).source_fragment_sha256 = "0".repeat(64);
      },
      "normative.registry.spec.requirement_1.source_fragment_sha256_mismatch",
    ],
    [
      "malformed source reference",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).source = "Purpose, lines 9–10 garbage 12";
      },
      "normative.registry.spec.requirement_1.source_lines_invalid",
    ],
    [
      "invalid metadata",
      (registry: MutableRegistry) => {
        registry.status = "Final";
      },
      "normative.registry.spec.metadata_invalid",
    ],
    [
      "invalid schema version",
      (registry: MutableRegistry) => {
        registry.schema_version = 2;
      },
      "normative.registry.spec.metadata_invalid",
    ],
    [
      "invalid document identity",
      (registry: MutableRegistry) => {
        registry.document = "OTHER";
      },
      "normative.registry.spec.metadata_invalid",
    ],
    [
      "invalid source file identity",
      (registry: MutableRegistry) => {
        registry.file = "OTHER.md";
      },
      "normative.registry.spec.metadata_invalid",
    ],
    [
      "invalid source digest metadata",
      (registry: MutableRegistry) => {
        registry.source_sha256 = "0".repeat(64);
      },
      "normative.registry.spec.metadata_invalid",
    ],
    [
      "missing requirement",
      (registry: MutableRegistry) => {
        registry.requirements.pop();
      },
      "normative.registry.spec.count_invalid",
    ],
    [
      "strength-count drift",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).strength = "SHOULD";
      },
      "normative.registry.spec.strength_count_invalid",
    ],
  ])("rejects %s", async (_label, mutation, diagnostic) => {
    const root = await registryFixture();
    await mutateRegistry(root, "spec", mutation);
    await expect(validateNormativeRegistry(root)).rejects.toThrow(diagnostic);
  });

  it("rejects membership cycles", async () => {
    const root = await registryFixture();
    await mutateRegistry(root, "spec", (registry) => {
      mutableRequirement(registry, 49).members = ["SPEC-R058"];
      mutableRequirement(registry, 57).members = ["SPEC-R050"];
    });
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.membership_cycle",
    );
  });

  it.each([
    [
      "statement reassignment",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 0).statement = "This row imposes no behavior.";
      },
    ],
    [
      "source reassignment",
      (registry: MutableRegistry) => {
        const first = mutableRequirement(registry, 0);
        const second = mutableRequirement(registry, 1);
        [first.source, second.source] = [second.source, first.source];
        [first.source_fragment_sha256, second.source_fragment_sha256] = [
          second.source_fragment_sha256,
          first.source_fragment_sha256,
        ];
      },
    ],
    [
      "strength reassignment",
      (registry: MutableRegistry) => {
        const must = mutableRequirement(registry, 0);
        const mustNot = mutableRequirement(registry, 48);
        [must.strength, mustNot.strength] = [mustNot.strength, must.strength];
      },
    ],
    [
      "kind weakening",
      (registry: MutableRegistry) => {
        const aggregate = mutableRequirement(registry, 49);
        aggregate.kind = "profile";
        aggregate.members = [];
      },
    ],
    [
      "membership reassignment",
      (registry: MutableRegistry) => {
        mutableRequirement(registry, 49).members = ["SPEC-R053"];
      },
    ],
  ])("rejects reviewed semantic %s", async (_label, mutation) => {
    const root = await registryFixture();
    await mutateRegistry(root, "spec", mutation);
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.registry_digest_mismatch",
    );
  });

  it("rejects source-document drift", async () => {
    const root = await registryFixture();
    await writeFile(path.join(root, "SPEC.md"), "changed\n", "utf8");
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.source_version_unknown",
    );
  });

  it("binds document identity to exact raw bytes", async () => {
    const root = await registryFixture();
    const sourcePath = path.join(root, "SPEC.md");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replaceAll("\n", "\r\n"), "utf8");
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.source_version_unknown",
    );
  });

  it.each([
    ["source", "SPEC.md", "normative.registry.spec.source_file_invalid"],
    [
      "registry",
      "docs/compliance/registry/spec.requirements.json",
      "normative.registry.spec.registry_file_invalid",
    ],
  ])("rejects a symlinked %s file", async (_label, relativePath, diagnostic) => {
    const root = await registryFixture();
    const filePath = path.join(root, relativePath);
    const target = path.join(root, `symlink-target-${path.basename(relativePath)}`);
    await writeFile(target, await readFile(filePath));
    await unlink(filePath);
    await symlink(target, filePath);
    await expect(validateNormativeRegistry(root)).rejects.toThrow(diagnostic);
  });

  it("rejects an oversized source before hashing it", async () => {
    const root = await registryFixture();
    await writeFile(path.join(root, "SPEC.md"), "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.source_size_invalid",
    );
  });

  it("rejects invalid JSON and oversized registries", async () => {
    const invalidRoot = await registryFixture();
    await writeFile(
      path.join(invalidRoot, "docs/compliance/registry/spec.requirements.json"),
      "{\n",
      "utf8",
    );
    await expect(validateNormativeRegistry(invalidRoot)).rejects.toThrow(
      "normative.registry.spec.json_invalid",
    );

    const oversizedRoot = await registryFixture();
    await writeFile(
      path.join(oversizedRoot, "docs/compliance/registry/spec.requirements.json"),
      "x".repeat(4 * 1024 * 1024 + 1),
      "utf8",
    );
    await expect(validateNormativeRegistry(oversizedRoot)).rejects.toThrow(
      "normative.registry.spec.registry_size_invalid",
    );
  });

  it("rejects duplicate JSON object keys", async () => {
    const root = await registryFixture();
    const registryPath = path.join(root, "docs/compliance/registry/spec.requirements.json");
    const source = await readFile(registryPath, "utf8");
    await writeFile(
      registryPath,
      source.replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,'),
      "utf8",
    );
    await expect(validateNormativeRegistry(root)).rejects.toThrow(
      "normative.registry.spec.json_duplicate_key",
    );
  });

  it("writes canonical CLI success and rejects extra arguments", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await expect(runNormativeRegistryCli(["--check"])).resolves.toBe(0);
    expect(output).toEqual(["normative registry: 761 requirements validated\n"]);
    output.length = 0;
    await expect(runNormativeRegistryCli(["--check", "extra"])).resolves.toBe(2);
    expect(output).toEqual([]);
  });
});
