import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  closePrivateArtifactStore,
  openPrivateArtifactStore,
  publishPrivateArtifact,
} from "./conformance-evidence/private-artifact-store.js";
import { produceTrustedEvidence } from "./conformance-evidence.js";
import {
  buildConformanceReport,
  type ConformanceReport,
  serializeConformanceReport,
} from "./conformance-report.js";

export const CONFORMANCE_REPORT_RELATIVE_PATH = "artifacts/conformance/core.json" as const;

export interface ConformanceCommandResult {
  readonly exitCode: 1;
  readonly report: ConformanceReport;
  readonly reportPath: string;
}

function owns(metadata: { readonly uid: number }): boolean {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

async function readImplementationVersion(root: string): Promise<string> {
  const source = await readFile(path.join(root, "package.json"), "utf8");
  const manifest = JSON.parse(source) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("invalid");
  }
  return manifest.version;
}

async function ensurePrivateDirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("conformance.report_directory_invalid");
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isDirectory() || !owns(before)) {
      throw new Error("invalid");
    }
    handle = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const held = await handle.stat({ bigint: false });
    if (!held.isDirectory() || !owns(held) || held.dev !== before.dev || held.ino !== before.ino) {
      throw new Error("invalid");
    }
    await handle.chmod(0o700);
    const hardened = await handle.stat({ bigint: false });
    const canonical = await realpath(target);
    const current = await lstat(target);
    if (
      canonical !== target ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !owns(current) ||
      (hardened.mode & 0o777) !== 0o700 ||
      hardened.dev !== held.dev ||
      hardened.ino !== held.ino ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw new Error("invalid");
    }
    return target;
  } catch {
    throw new Error("conformance.report_directory_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishConformanceReport(root: string, report: ConformanceReport): Promise<string> {
  const artifacts = await ensurePrivateDirectory(root, "artifacts");
  const directory = await ensurePrivateDirectory(artifacts, "conformance");
  const store = await openPrivateArtifactStore(directory);
  try {
    if (store.path !== directory) throw new Error("conformance.report_directory_invalid");
    await publishPrivateArtifact(
      store,
      "core.json",
      Buffer.from(serializeConformanceReport(report), "utf8"),
    );
  } finally {
    await closePrivateArtifactStore(store).catch(() => undefined);
  }
  return path.join(directory, "core.json");
}

export async function runConformanceCommand(): Promise<ConformanceCommandResult> {
  const root = await realpath(process.cwd()).catch(() => undefined);
  if (root === undefined) throw new Error("conformance.repository_root_invalid");
  const privateEvidenceDirectory = await mkdtemp(
    path.join(tmpdir(), "symphony-conformance-evidence-"),
  );
  const commandDiagnostics: string[] = [];
  let evidence: unknown = null;
  let implementationVersion: string | null = null;
  try {
    try {
      evidence = await produceTrustedEvidence(privateEvidenceDirectory);
    } catch {
      commandDiagnostics.push("conformance.evidence.production_failed");
    }
    try {
      implementationVersion = await readImplementationVersion(root);
    } catch {
      commandDiagnostics.push("conformance.implementation_version_invalid");
    }
    const report = buildConformanceReport({
      commandDiagnostics,
      evidence,
      implementationVersion,
    });
    const reportPath = await publishConformanceReport(root, report);
    return { exitCode: 1, report, reportPath };
  } finally {
    await rm(privateEvidenceDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runConformanceCli(args: readonly string[]): Promise<number> {
  if (args.length !== 0) return 2;
  const result = await runConformanceCommand();
  process.stdout.write(`${result.reportPath}\n`);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await runConformanceCli(process.argv.slice(2));
  } catch {
    process.stderr.write("conformance.command_failed\n");
    process.exitCode = 1;
  }
}
