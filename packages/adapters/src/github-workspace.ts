import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRepositoryAdapter } from "./contracts.js";
import type { GhCliApiClient } from "./gh-cli-api.js";
import { issueWorkspacePath, resolveAssignedWorkspace } from "./workspace-boundary.js";

const GH_ENVIRONMENT_KEYS = [
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "XDG_CONFIG_HOME",
] as const;

const GIT_ENVIRONMENT_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "XDG_CONFIG_HOME"] as const;

export interface WorkspaceCommandRequest {
  arguments: readonly string[];
  command: "gh" | "git";
  cwd: string;
  environment: Readonly<Record<string, string>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface WorkspaceCommandRunner {
  run(request: WorkspaceCommandRequest): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
}

interface RepositoryMetadataResponse {
  repository: {
    defaultBranchRef: { name: string; target: { oid: string } } | null;
    nameWithOwner: string;
  } | null;
}

const REPOSITORY_METADATA_QUERY = `
  query SymphonyWorkspaceRepository($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      defaultBranchRef {
        name
        target { ... on Commit { oid } }
      }
    }
  }
`;

export function createGitHubWorkspaceRepositoryAdapter(options: {
  api: GhCliApiClient;
  commandRunner: WorkspaceCommandRunner;
  environment: Readonly<Record<string, string | undefined>>;
  now?: () => string;
  timeoutMs: number;
}): WorkspaceRepositoryAdapter {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async populateIssueWorkspace(input) {
      const [owner, name, extra] = input.repository.split("/");
      if (!owner || !name || extra !== undefined) throw new Error("workspace.repository_invalid");
      if (!input.identifier) throw new Error("workspace.identifier_invalid");
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("workspace.timeout_invalid");
      }
      const metadata = await options.api.graphql<RepositoryMetadataResponse>(
        REPOSITORY_METADATA_QUERY,
        { name, owner },
      );
      const repository = metadata.data.repository;
      const defaultBranch = repository?.defaultBranchRef;
      const baseSha = defaultBranch?.target.oid;
      if (
        !repository ||
        repository.nameWithOwner.toLocaleLowerCase("en-US") !==
          input.repository.toLocaleLowerCase("en-US") ||
        !defaultBranch ||
        !defaultBranch.name ||
        typeof baseSha !== "string" ||
        !/^[A-Fa-f0-9]{7,64}$/u.test(baseSha)
      ) {
        throw new Error("workspace.repository_metadata_invalid");
      }
      await mkdir(input.workspaceRoot, { recursive: true });
      const workspaceRoot = await realpath(input.workspaceRoot);
      const workspacePath = issueWorkspacePath(workspaceRoot, input.identifier);
      assertLexicalDescendant(workspaceRoot, workspacePath);
      if (await pathExists(workspacePath)) throw new Error("workspace.already_exists");
      const localBranch = localBranchName(input.identifier);
      try {
        await runRequired(options.commandRunner, {
          arguments: ["repo", "clone", input.repository, workspacePath, "--", "--no-checkout"],
          command: "gh",
          cwd: workspaceRoot,
          environment: allowlistedEnvironment(options.environment, GH_ENVIRONMENT_KEYS),
          maxOutputBytes: 1_000_000,
          timeoutMs: options.timeoutMs,
        });
        const resolvedWorkspace = await resolveAssignedWorkspace(workspaceRoot, workspacePath);
        await runRequired(options.commandRunner, {
          arguments: ["-C", resolvedWorkspace, "switch", "--create", localBranch, baseSha],
          command: "git",
          cwd: workspaceRoot,
          environment: allowlistedEnvironment(options.environment, GIT_ENVIRONMENT_KEYS),
          maxOutputBytes: 1_000_000,
          timeoutMs: options.timeoutMs,
        });
        const revision = await runRequired(options.commandRunner, {
          arguments: ["-C", resolvedWorkspace, "rev-parse", "HEAD"],
          command: "git",
          cwd: workspaceRoot,
          environment: allowlistedEnvironment(options.environment, GIT_ENVIRONMENT_KEYS),
          maxOutputBytes: 1_000_000,
          timeoutMs: options.timeoutMs,
        });
        if (
          revision.stdout.trim().toLocaleLowerCase("en-US") !== baseSha.toLocaleLowerCase("en-US")
        ) {
          throw new Error("workspace.base_revision_mismatch");
        }
        const createdAt = now();
        if (!Number.isFinite(Date.parse(createdAt))) throw new Error("workspace.timestamp_invalid");
        return {
          baseSha,
          checkoutMethod: "trusted_repository_adapter",
          createdAt,
          localBranch,
          repository: input.repository,
          workspacePath: resolvedWorkspace,
        };
      } catch (error) {
        await rm(workspacePath, { force: true, recursive: true });
        throw error;
      }
    },
  };
}

export function createNodeWorkspaceCommandRunner(): WorkspaceCommandRunner {
  return {
    run(request) {
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        return Promise.reject(new Error("workspace.command_timeout_invalid"));
      }
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
        return Promise.reject(new Error("workspace.command_output_limit_invalid"));
      }
      return new Promise((resolve, reject) => {
        const child = spawn(request.command, [...request.arguments], {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: { ...request.environment },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let failure: Error | null = null;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const signal = (name: NodeJS.Signals) => {
          try {
            if (child.pid !== undefined && process.platform !== "win32")
              process.kill(-child.pid, name);
            else child.kill(name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        };
        const terminate = (error: Error) => {
          if (failure) return;
          failure = error;
          signal("SIGTERM");
          killTimer = setTimeout(() => signal("SIGKILL"), 250);
          killTimer.unref();
        };
        const append = (target: Buffer[], chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > request.maxOutputBytes)
            terminate(new Error("workspace.command_output_limit"));
          else target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          reject(error);
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          if (failure) reject(failure);
          else {
            resolve({
              exitCode: code ?? -1,
              stderr: Buffer.concat(stderr).toString("utf8"),
              stdout: Buffer.concat(stdout).toString("utf8"),
            });
          }
        });
        const timeout = setTimeout(
          () => terminate(new Error("workspace.command_timeout")),
          request.timeoutMs,
        );
        timeout.unref();
      });
    },
  };
}

export async function readWorkspaceHeadRevision(options: {
  commandRunner: WorkspaceCommandRunner;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  workspace: string;
  workspaceRoot: string;
}): Promise<string> {
  const workspace = await resolveAssignedWorkspace(options.workspaceRoot, options.workspace);
  const result = await runRequired(options.commandRunner, {
    arguments: ["-C", workspace, "rev-parse", "HEAD"],
    command: "git",
    cwd: options.workspaceRoot,
    environment: allowlistedEnvironment(options.environment, GIT_ENVIRONMENT_KEYS),
    maxOutputBytes: 1_000_000,
    timeoutMs: options.timeoutMs,
  });
  const revision = result.stdout.trim();
  if (!/^[A-Fa-f0-9]{7,64}$/u.test(revision)) {
    throw new Error("workspace.head_revision_invalid");
  }
  return revision;
}

async function runRequired(
  runner: WorkspaceCommandRunner,
  request: WorkspaceCommandRequest,
): Promise<Awaited<ReturnType<WorkspaceCommandRunner["run"]>>> {
  let result: Awaited<ReturnType<WorkspaceCommandRunner["run"]>>;
  try {
    result = await runner.run(request);
  } catch {
    throw new Error("workspace.command_failed");
  }
  if (result.exitCode !== 0) {
    throw new Error(request.command === "gh" ? "workspace.clone_failed" : "workspace.git_failed");
  }
  return result;
}

function allowlistedEnvironment<const Keys extends readonly string[]>(
  source: Readonly<Record<string, string | undefined>>,
  keys: Keys,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}

function localBranchName(identifier: string): string {
  const label =
    identifier
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "work";
  const digest = createHash("sha256").update(identifier).digest("hex").slice(0, 12);
  return `symphony/${label}-${digest}`;
}

function assertLexicalDescendant(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("workspace.outside_root");
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
