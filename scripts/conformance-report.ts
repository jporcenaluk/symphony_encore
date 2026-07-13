import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface CoreMatrix {
  completed: string[];
  missing: string[];
}

export function readCoreMatrix(ledger: string): CoreMatrix {
  const completed: string[] = [];
  const missing: string[] = [];
  for (const match of ledger.matchAll(/^- \[([ x])\] `((?:C-)[A-Z]+-[0-9]{2})`/gmu)) {
    const target = match[1] === "x" ? completed : missing;
    const id = match[2];
    if (id) target.push(id);
  }
  return { completed, missing };
}

export function specificationRequirementsComplete(ledger: string): boolean {
  const statuses = [
    ...ledger.matchAll(/^\| S[0-9]{2} \|[^\n]+\| (Implemented|In progress|Not started) \|/gmu),
  ].map((match) => match[1]);
  return statuses.length === 19 && statuses.every((status) => status === "Implemented");
}

export function buildConformanceReport(input: {
  generatedAt: string;
  implementationVersion: string;
  matrix: CoreMatrix;
  requirementsComplete: boolean;
  revision: string;
}) {
  const deterministicPassed =
    input.requirementsComplete &&
    input.matrix.completed.length > 0 &&
    input.matrix.missing.length === 0;
  const realIntegration = { report: null, status: "not_run" as const };
  return {
    adapters: [
      { kind: "tracker", name: "github", status: "partial", version: "0.0.0" },
      {
        kind: "repository_host",
        name: "github",
        status: "partial",
        version: "0.0.0",
      },
      {
        kind: "agent",
        name: "codex_app_server",
        status: "contract_only",
        version: "0.0.0",
      },
      { kind: "authentication", name: "local", status: "implemented", version: "0.0.0" },
    ],
    core_conformance: deterministicPassed,
    enabled_extensions: [],
    generated_at: input.generatedAt,
    implementation: {
      name: "symphony-encore",
      revision: input.revision,
      version: input.implementationVersion,
    },
    implementation_defined_choices: [
      "single configured project per service instance",
      "local SQLite in WAL mode",
      "loopback-only first-run bootstrap",
      "supervised learning synthesis",
    ],
    production_ready: false,
    results: {
      deterministic: {
        completed_ids: [...input.matrix.completed],
        missing_ids: [...input.matrix.missing],
        status: deterministicPassed ? ("passed" as const) : ("incomplete" as const),
      },
      real_integration: realIntegration,
    },
    schema_version: 1,
    spec: { document: "SPEC.md", status: "Draft v3" },
    test_command: "make conformance",
  };
}

export async function readGitRevision(root: string): Promise<string> {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const gitEntry = path.join(root, ".git");
  const gitEntryStat = await lstat(gitEntry);
  let gitDirectory = gitEntry;
  if (!gitEntryStat.isDirectory()) {
    const pointer = (await readFile(gitEntry, "utf8")).trim();
    if (!pointer.startsWith("gitdir: ")) throw new Error("conformance.gitdir_invalid");
    gitDirectory = path.resolve(root, pointer.slice("gitdir: ".length));
  }
  const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice("ref: ".length);
  try {
    return (await readFile(path.join(gitDirectory, ref), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const packedRefs = await readFile(path.join(gitDirectory, "packed-refs"), "utf8");
  const match = packedRefs
    .split(/\r?\n/u)
    .find((line) => !line.startsWith("#") && line.endsWith(` ${ref}`));
  const revision = match?.split(" ")[0];
  if (!revision) throw new Error("conformance.git_ref_missing");
  return revision;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const [ledger, manifestSource] = await Promise.all([
    readFile(path.join(root, "IMPLEMENTATION_STATUS.md"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as { version: string };
  const revision = await readGitRevision(root);
  const report = buildConformanceReport({
    generatedAt: new Date().toISOString(),
    implementationVersion: manifest.version,
    matrix: readCoreMatrix(ledger),
    requirementsComplete: specificationRequirementsComplete(ledger),
    revision,
  });
  const reportPath = path.resolve(
    root,
    process.argv[2] ?? path.join("artifacts", "conformance", "core.json"),
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${reportPath}\n`);
  if (!report.core_conformance) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
