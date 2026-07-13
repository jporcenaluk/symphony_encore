import { runLinuxSandboxed } from "./linux-sandbox.js";
import {
  buildScrubbedWorkerEnvironment,
  prepareWorkerStateDirectories,
} from "./workspace-boundary.js";

export type HookKind = "after_create" | "before_run" | "after_run" | "before_remove";

export interface LinuxHookRequest {
  allowlistedEnvironmentNames: readonly string[];
  command: string;
  kind: HookKind;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  workspace: string;
  workspaceRoot: string;
}

export interface HookExecutionResult {
  exitCode: number | null;
  fatal: boolean;
  status: "passed" | "failed" | "error";
  stderr: string;
  stdout: string;
}

function failureIsFatal(kind: HookKind): boolean {
  return kind === "after_create" || kind === "before_run";
}

export async function runLinuxHook(request: LinuxHookRequest): Promise<HookExecutionResult> {
  const fatal = failureIsFatal(request.kind);
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
    const passed = execution.exitCode === 0 && execution.signal === null;
    return {
      exitCode: execution.exitCode,
      fatal,
      status: passed ? "passed" : "failed",
      stderr: execution.stderr,
      stdout: execution.stdout,
    };
  } catch (error) {
    return {
      exitCode: null,
      fatal,
      status: "error",
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
}
