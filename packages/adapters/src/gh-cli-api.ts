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

export interface GhCommandRequest {
  arguments: readonly string[];
  command: "gh";
  environment: Readonly<Record<string, string>>;
  maxOutputBytes: number;
  stdin: string;
  timeoutMs: number;
}

export interface GhCommandRunner {
  run(request: GhCommandRequest): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
}

export function createNodeGhCommandRunner(): GhCommandRunner {
  return {
    run(request) {
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
        return Promise.reject(new Error("gh.invalid_timeout"));
      }
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
        return Promise.reject(new Error("gh.invalid_output_limit"));
      }
      return new Promise((resolve, reject) => {
        const child = spawn(request.command, [...request.arguments], {
          detached: process.platform !== "win32",
          env: { ...request.environment },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let failure: Error | null = null;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          operation();
        };
        const signal = (name: NodeJS.Signals) => {
          try {
            if (child.pid !== undefined && process.platform !== "win32") {
              process.kill(-child.pid, name);
            } else {
              child.kill(name);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        };
        const terminate = (error: Error) => {
          if (failure !== null) return;
          failure = error;
          signal("SIGTERM");
          killTimer = setTimeout(() => signal("SIGKILL"), 250);
          killTimer.unref();
        };
        const append = (target: Buffer[], chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > request.maxOutputBytes) {
            terminate(new Error("gh.output_limit"));
            return;
          }
          target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") terminate(error);
        });
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code) =>
          finish(() => {
            if (failure) reject(failure);
            else {
              resolve({
                exitCode: code ?? -1,
                stderr: Buffer.concat(stderr).toString("utf8"),
                stdout: Buffer.concat(stdout).toString("utf8"),
              });
            }
          }),
        );
        const timeout = setTimeout(() => terminate(new Error("gh.timeout")), request.timeoutMs);
        timeout.unref();
        child.stdin.end(request.stdin);
      });
    },
  };
}

export type GitHubApiErrorCode =
  | "github.auth_failed"
  | "github.graphql_error"
  | "github.invalid_response"
  | "github.missing_request_id"
  | "github.transport_failed";

export class GitHubApiError extends Error {
  readonly code: GitHubApiErrorCode;

  constructor(code: GitHubApiErrorCode) {
    super(code);
    this.name = "GitHubApiError";
    this.code = code;
  }
}

export interface GhApiResponse<T> {
  data: T;
  requestId: string;
}

export function createGhCliApiClient(options: {
  environment: Readonly<Record<string, string | undefined>>;
  runner: GhCommandRunner;
  timeoutMs: number;
}) {
  const environment = allowlistedEnvironment(options.environment);
  return {
    async graphql<T>(
      query: string,
      variables: Readonly<Record<string, unknown>>,
    ): Promise<GhApiResponse<T>> {
      let result: Awaited<ReturnType<GhCommandRunner["run"]>>;
      try {
        result = await options.runner.run({
          arguments: ["api", "graphql", "--include", "--input", "-"],
          command: "gh",
          environment,
          maxOutputBytes: 2_000_000,
          stdin: JSON.stringify({ query, variables }),
          timeoutMs: options.timeoutMs,
        });
      } catch {
        throw new GitHubApiError("github.transport_failed");
      }
      if (result.exitCode !== 0) {
        throw new GitHubApiError(
          isAuthenticationFailure(result.stderr) ? "github.auth_failed" : "github.transport_failed",
        );
      }
      return parseGraphqlResponse<T>(result.stdout);
    },
  };
}

function allowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of GH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  return environment;
}

function parseGraphqlResponse<T>(value: string): GhApiResponse<T> {
  const separator = /\r?\n\r?\n/u.exec(value);
  if (separator?.index === undefined) throw new GitHubApiError("github.invalid_response");
  const rawHeaders = value.slice(0, separator.index);
  const rawBody = value.slice(separator.index + separator[0].length);
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split(/\r?\n/u).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(
      line.slice(0, colon).trim().toLocaleLowerCase("en-US"),
      line.slice(colon + 1).trim(),
    );
  }
  const requestId = headers.get("x-github-request-id");
  if (!requestId) throw new GitHubApiError("github.missing_request_id");

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new GitHubApiError("github.invalid_response");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new GitHubApiError("github.invalid_response");
  }
  if ("errors" in payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    const forbidden = payload.errors.some(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        (error.type === "FORBIDDEN" || error.type === "UNAUTHORIZED"),
    );
    throw new GitHubApiError(forbidden ? "github.auth_failed" : "github.graphql_error");
  }
  if (!("data" in payload) || payload.data === null || typeof payload.data !== "object") {
    throw new GitHubApiError("github.invalid_response");
  }
  return { data: payload.data as T, requestId };
}

function isAuthenticationFailure(stderr: string): boolean {
  return /(?:401|bad credentials|authentication|not logged in)/iu.test(stderr);
}

import { spawn } from "node:child_process";
