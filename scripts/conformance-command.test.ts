import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFORMANCE_REPORT_RELATIVE_PATH,
  runConformanceCli,
  runConformanceCommand,
} from "./conformance-command.js";
import { captureRepositorySnapshot } from "./conformance-evidence/repository-snapshot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "conformance@example.invalid",
      GIT_AUTHOR_NAME: "Conformance Test",
      GIT_COMMITTER_EMAIL: "conformance@example.invalid",
      GIT_COMMITTER_NAME: "Conformance Test",
      HOME: root,
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    shell: false,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

async function repository(manifest: unknown = { name: "fixture", version: "0.0.0" }) {
  const root = await temporaryDirectory("symphony-command-root-");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "package.json"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

async function inRepository<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await operation();
  } finally {
    process.chdir(previous);
  }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("conformance command", () => {
  it("uses the literal repository report path", () => {
    expect(CONFORMANCE_REPORT_RELATIVE_PATH).toBe("artifacts/conformance/core.json");
  });

  it("owns evidence production and writes the fixed incomplete report through the real CLI", async () => {
    const root = await repository();
    const command = fileURLToPath(new URL("./conformance-command.ts", import.meta.url));
    const loader = fileURLToPath(new URL("./typescript-source-loader.mjs", import.meta.url));
    const environment = { ...process.env };
    delete environment.GITHUB_SHA;
    delete environment.SOURCE_DATE_EPOCH;

    const execution = spawnSync(
      process.execPath,
      ["--conditions=development", "--import", loader, command],
      { cwd: root, encoding: "utf8", env: environment, shell: false },
    );
    const reportPath = path.join(root, CONFORMANCE_REPORT_RELATIVE_PATH);
    expect({ status: execution.status, stderr: execution.stderr }).toEqual({
      status: 1,
      stderr: "",
    });
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      core_conformance: boolean;
      production_ready: boolean;
      results: { core_evidence: { trusted: boolean } };
    };
    expect(report).toMatchObject({
      core_conformance: false,
      production_ready: false,
      results: { core_evidence: { trusted: true } },
    });
  });

  it("publishes a useful rejected report when implementation provenance is invalid", async () => {
    const root = await repository({ name: "fixture" });
    const result = await inRepository(root, () => runConformanceCommand());
    expect(result.exitCode).toBe(1);
    expect(result.report.implementation.version).toBeNull();
    expect(result.report.results.core_evidence.diagnostics).toContain(
      "conformance.implementation_version_invalid",
    );
    expect(JSON.parse(await readFile(result.reportPath, "utf8"))).toEqual(result.report);
  });

  it("publishes a useful incomplete report when the repository is dirty", async () => {
    const root = await repository();
    await writeFile(path.join(root, "dirty.txt"), "dirty\n", "utf8");
    const directStatus = spawnSync(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
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
    expect(directStatus).toMatchObject({ status: 0, stderr: "", stdout: "?? dirty.txt\n" });
    const snapshot = await inRepository(root, () => captureRepositorySnapshot());
    expect(snapshot.diagnostics).toEqual(["evidence.repository.dirty"]);
    const result = await inRepository(root, () => runConformanceCommand());
    expect(result.report.results.core_evidence).toMatchObject({
      diagnostics: expect.arrayContaining(["evidence.repository.dirty"]),
      status: "incomplete",
      trusted: true,
    });
    expect(result.reportPath).toBe(
      path.join(await realpath(root), CONFORMANCE_REPORT_RELATIVE_PATH),
    );
  });

  it("rejects a symlinked report directory without writing outside the repository", async () => {
    const root = await repository();
    const outside = await temporaryDirectory("symphony-command-outside-");
    await writeFile(path.join(outside, "core.json"), "outside\n", "utf8");
    await mkdir(path.join(root, "artifacts"), { mode: 0o700 });
    await symlink(outside, path.join(root, "artifacts", "conformance"), "dir");

    await expect(inRepository(root, () => runConformanceCommand())).rejects.toThrow(
      "conformance.report_directory_invalid",
    );
    expect(await readFile(path.join(outside, "core.json"), "utf8")).toBe("outside\n");
  });

  it("rejects a symlinked report target", async () => {
    const root = await repository();
    const outside = path.join(await temporaryDirectory("symphony-command-target-"), "outside.json");
    await writeFile(outside, "outside\n", "utf8");
    const reportDirectory = path.join(root, "artifacts", "conformance");
    await mkdir(reportDirectory, { mode: 0o700, recursive: true });
    await symlink(outside, path.join(reportDirectory, "core.json"));

    await expect(inRepository(root, () => runConformanceCommand())).rejects.toThrow(
      "evidence.private_artifact_invalid",
    );
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("does not accept a caller-supplied output path", async () => {
    await expect(runConformanceCli(["elsewhere.json"])).resolves.toBe(2);
  });
});
