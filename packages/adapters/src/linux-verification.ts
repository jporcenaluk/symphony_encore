import { createHash } from "node:crypto";

import { runLinuxSandboxed } from "./linux-sandbox.js";
import {
  buildScrubbedWorkerEnvironment,
  isSensitiveEnvironmentName,
  prepareWorkerStateDirectories,
} from "./workspace-boundary.js";

export interface LinuxVerificationRequest {
  allowlistedEnvironmentNames: readonly string[];
  command: string;
  now?: () => string;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  workspace: string;
  workspaceRoot: string;
}

export interface VerificationExecutionResult {
  commandHash: string;
  endedAt: string;
  environmentPolicyHash: string;
  exitCode: number;
  result: "passed" | "failed" | "error";
  startedAt: string;
  stderr: string;
  stdout: string;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function runLinuxVerification(
  request: LinuxVerificationRequest,
): Promise<VerificationExecutionResult> {
  const now = request.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const commandHash = sha256(request.command);
  const effectiveAllowlist = request.allowlistedEnvironmentNames
    .filter((name) => !isSensitiveEnvironmentName(name))
    .toSorted();
  const environmentPolicyHash = sha256(
    JSON.stringify({ allowlist: effectiveAllowlist, sandbox: "linux-bwrap-v1" }),
  );

  try {
    await prepareWorkerStateDirectories(request.workspace);
    const environment = buildScrubbedWorkerEnvironment(
      request.workspace,
      request.sourceEnvironment,
      request.allowlistedEnvironmentNames,
    );
    const execution = await runLinuxSandboxed({
      args: ["-c", request.command],
      command: "/bin/bash",
      environment,
      timeoutMs: request.timeoutMs,
      workspace: request.workspace,
      workspaceRoot: request.workspaceRoot,
    });
    const exitCode = execution.exitCode ?? -1;
    return {
      commandHash,
      endedAt: now(),
      environmentPolicyHash,
      exitCode,
      result: execution.signal === null && exitCode === 0 ? "passed" : "failed",
      startedAt,
      stderr: execution.stderr,
      stdout: execution.stdout,
    };
  } catch (error) {
    return {
      commandHash,
      endedAt: now(),
      environmentPolicyHash,
      exitCode: -1,
      result: "error",
      startedAt,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
}
