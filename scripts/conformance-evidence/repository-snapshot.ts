import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface RepositorySnapshot {
  readonly diagnostics: readonly string[];
  readonly repositoryRoot: string | null;
  readonly revision: string | null;
  readonly sourceDateEpoch: number | null;
  readonly tree: string | null;
}

export interface RepositoryProbe {
  readonly head: GitProbeResult;
  readonly root: GitProbeResult;
  readonly status: GitProbeResult;
  readonly timestamp?: GitProbeResult;
  readonly tree: GitProbeResult;
}

export type GitProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly diagnostic: string; readonly ok: false };

export interface RepositorySnapshotInputs {
  readonly cwd: string;
  readonly githubSha?: string;
  readonly sourceDateEpoch?: string;
}

interface VerifiedGit {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

function emptySnapshot(diagnostic: string, detail?: string): RepositorySnapshot {
  return {
    diagnostics: detail === undefined ? [diagnostic] : [diagnostic, detail],
    repositoryRoot: null,
    revision: null,
    sourceDateEpoch: null,
    tree: null,
  };
}

function failed(result: GitProbeResult, diagnostic: string): RepositorySnapshot | undefined {
  return result.ok ? undefined : emptySnapshot(diagnostic, result.diagnostic);
}

export function repositorySnapshotFromProbe(
  probe: RepositoryProbe,
  inputs: RepositorySnapshotInputs,
): RepositorySnapshot {
  const statusFailure = failed(probe.status, "evidence.repository.status_failed");
  if (statusFailure !== undefined) return statusFailure;
  if (!probe.status.ok) return emptySnapshot("evidence.repository.status_failed");
  if (probe.status.stdout.trim().length > 0) return emptySnapshot("evidence.repository.dirty");

  const rootFailure = failed(probe.root, "evidence.repository.root_invalid");
  if (rootFailure !== undefined) return rootFailure;
  if (!probe.root.ok || path.resolve(probe.root.stdout.trim()) !== path.resolve(inputs.cwd)) {
    return emptySnapshot("evidence.repository.root_invalid");
  }

  const headFailure = failed(probe.head, "evidence.repository.revision_invalid");
  if (headFailure !== undefined) return headFailure;
  if (!probe.head.ok || !REVISION_PATTERN.test(probe.head.stdout.trim())) {
    return emptySnapshot("evidence.repository.revision_invalid");
  }
  const revision = probe.head.stdout.trim();

  const treeFailure = failed(probe.tree, "evidence.repository.tree_invalid");
  if (treeFailure !== undefined) return treeFailure;
  if (!probe.tree.ok || !REVISION_PATTERN.test(probe.tree.stdout.trim())) {
    return emptySnapshot("evidence.repository.tree_invalid");
  }
  const tree = probe.tree.stdout.trim();

  if (
    inputs.githubSha !== undefined &&
    (!REVISION_PATTERN.test(inputs.githubSha) || inputs.githubSha !== revision)
  ) {
    return emptySnapshot("evidence.repository.github_sha_mismatch");
  }

  const epochText = inputs.sourceDateEpoch;
  if (epochText !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(epochText)) {
      return emptySnapshot("evidence.repository.source_date_epoch_invalid");
    }
    const sourceDateEpoch = Number(epochText);
    if (!Number.isSafeInteger(sourceDateEpoch)) {
      return emptySnapshot("evidence.repository.source_date_epoch_invalid");
    }
    return {
      diagnostics: [],
      repositoryRoot: path.resolve(inputs.cwd),
      revision,
      sourceDateEpoch,
      tree,
    };
  }

  if (probe.timestamp === undefined) {
    return emptySnapshot("evidence.repository.head_timestamp_invalid");
  }
  const timestampFailure = failed(probe.timestamp, "evidence.repository.head_timestamp_invalid");
  if (timestampFailure !== undefined) return timestampFailure;
  if (!probe.timestamp.ok || !/^(?:0|[1-9][0-9]*)$/u.test(probe.timestamp.stdout.trim())) {
    return emptySnapshot("evidence.repository.head_timestamp_invalid");
  }
  const sourceDateEpoch = Number(probe.timestamp.stdout.trim());
  if (!Number.isSafeInteger(sourceDateEpoch)) {
    return emptySnapshot("evidence.repository.head_timestamp_invalid");
  }
  return {
    diagnostics: [],
    repositoryRoot: path.resolve(inputs.cwd),
    revision,
    sourceDateEpoch,
    tree,
  };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    FORCE_COLOR: "0",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
}

async function verifyGit(candidate: string): Promise<VerifiedGit | undefined> {
  try {
    const executablePath = await realpath(candidate);
    const metadata = await stat(executablePath);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
      return undefined;
    }
    return {
      device: metadata.dev,
      inode: metadata.ino,
      path: executablePath,
      sha256: createHash("sha256")
        .update(await readFile(executablePath))
        .digest("hex"),
      size: metadata.size,
    };
  } catch {
    return undefined;
  }
}

async function resolveGit(): Promise<VerifiedGit | undefined> {
  for (const candidate of ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]) {
    const git = await verifyGit(candidate);
    if (git !== undefined) return git;
  }
  return undefined;
}

async function gitUnchanged(git: VerifiedGit): Promise<boolean> {
  const current = await verifyGit(git.path);
  return (
    current !== undefined &&
    current.device === git.device &&
    current.inode === git.inode &&
    current.size === git.size &&
    current.sha256 === git.sha256
  );
}

function runGit(git: VerifiedGit, cwd: string, args: readonly string[]): GitProbeResult {
  const hardenedArgs = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];
  const result = spawnSync(git.path, hardenedArgs, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return { diagnostic: "evidence.git.command_failed", ok: false };
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    return {
      diagnostic: `evidence.git.stderr:sha256:${createHash("sha256").update(result.stderr).digest("hex")}`,
      ok: false,
    };
  }
  return { ok: true, stdout: result.stdout };
}

export async function captureRepositorySnapshot(): Promise<RepositorySnapshot> {
  const git = await resolveGit();
  if (git === undefined) return emptySnapshot("evidence.repository.git_invalid");
  const cwd = await realpath(process.cwd()).catch(() => undefined);
  if (cwd === undefined) return emptySnapshot("evidence.repository.root_invalid");
  const configuredEpoch = process.env.SOURCE_DATE_EPOCH;
  const probe: RepositoryProbe = {
    head: runGit(git, cwd, ["rev-parse", "HEAD"]),
    root: runGit(git, cwd, ["rev-parse", "--show-toplevel"]),
    status: runGit(git, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ...(configuredEpoch === undefined
      ? { timestamp: runGit(git, cwd, ["show", "-s", "--format=%ct", "HEAD"]) }
      : {}),
    tree: runGit(git, cwd, ["rev-parse", "HEAD^{tree}"]),
  };
  if (!(await gitUnchanged(git))) {
    return emptySnapshot("evidence.repository.git_changed");
  }
  return repositorySnapshotFromProbe(probe, {
    cwd,
    ...(process.env.GITHUB_SHA === undefined ? {} : { githubSha: process.env.GITHUB_SHA }),
    ...(configuredEpoch === undefined ? {} : { sourceDateEpoch: configuredEpoch }),
  });
}

export function snapshotsMatch(before: RepositorySnapshot, after: RepositorySnapshot): boolean {
  return (
    before.diagnostics.length === 0 &&
    after.diagnostics.length === 0 &&
    before.repositoryRoot === after.repositoryRoot &&
    before.revision === after.revision &&
    before.sourceDateEpoch === after.sourceDateEpoch &&
    before.tree === after.tree
  );
}

export function changedRepositorySnapshot(): RepositorySnapshot {
  return emptySnapshot("evidence.repository.changed_during_run");
}
