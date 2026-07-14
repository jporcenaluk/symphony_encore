import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Execution {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function execute(cwd: string, args: readonly string[], caseId: string): Promise<Execution> {
  const cli = path.resolve("scripts/normative-registry-cli.ts");
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  try {
    process.chdir(cwd);
    process.argv = [process.execPath, cli, ...args];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: Uint8Array | string) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: Uint8Array | string) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import(`${pathToFileURL(cli).href}?case=${caseId}`);
    return { code: process.exitCode ?? 0, stderr, stdout };
  } finally {
    process.argv = previousArgv;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
  }
}

async function invalidRepositoryFixture(root: string): Promise<string> {
  const fixture = await mkdtemp(path.join(tmpdir(), "symphony-normative-cli-"));
  await mkdir(path.join(fixture, "docs/compliance/registry"), { recursive: true });
  await Promise.all(
    [
      "TECH_STACK.md",
      "CICD.md",
      "docs/compliance/registry/spec.requirements.json",
      "docs/compliance/registry/tech-stack.requirements.json",
      "docs/compliance/registry/cicd.requirements.json",
    ].map((file) => copyFile(path.join(root, file), path.join(fixture, file))),
  );
  await writeFile(path.join(fixture, "SPEC.md"), "changed\n", "utf8");
  return fixture;
}

const root = process.cwd();
let fixture: string | undefined;
try {
  assert.deepEqual(await execute(root, ["--check"], "success"), {
    code: 0,
    stderr: "",
    stdout: "normative registry: 761 requirements validated\n",
  });
  assert.deepEqual(await execute(root, ["--check", "extra"], "arguments"), {
    code: 2,
    stderr: "",
    stdout: "",
  });
  fixture = await invalidRepositoryFixture(root);
  assert.deepEqual(await execute(fixture, ["--check"], "failure"), {
    code: 1,
    stderr: "normative.registry.spec.source_version_unknown\n",
    stdout: "",
  });
  process.stdout.write("normative registry CLI: verified\n");
} finally {
  if (fixture !== undefined) await rm(fixture, { force: true, recursive: true });
}
