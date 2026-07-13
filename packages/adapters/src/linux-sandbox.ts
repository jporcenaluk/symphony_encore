import { spawn } from "node:child_process";

import { isSensitiveEnvironmentName, resolveAssignedWorkspace } from "./workspace-boundary.js";

export interface LinuxSandboxRequest {
  args: readonly string[];
  command: string;
  environment: Readonly<Record<string, string>>;
  maxOutputBytes?: number;
  workspace: string;
  workspaceRoot: string;
}

export interface SandboxedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

export async function runLinuxSandboxed(
  request: LinuxSandboxRequest,
): Promise<SandboxedProcessResult> {
  if (process.platform !== "linux") throw new Error("sandbox.linux_required");
  const workspace = await resolveAssignedWorkspace(request.workspaceRoot, request.workspace);
  const sandboxArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/ca-certificates",
    "/etc/ca-certificates",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/hosts",
    "/etc/hosts",
    "--ro-bind-try",
    "/etc/nsswitch.conf",
    "/etc/nsswitch.conf",
    "--ro-bind-try",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind-try",
    "/etc/group",
    "/etc/group",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dir",
    workspace,
    "--remount-ro",
    "/tmp",
    "--remount-ro",
    "/run",
    "--remount-ro",
    "/",
    "--bind",
    workspace,
    workspace,
    "--chdir",
    workspace,
    "--clearenv",
  ];
  for (const [name, value] of Object.entries(request.environment).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isSensitiveEnvironmentName(name)) sandboxArgs.push("--setenv", name, value);
  }
  sandboxArgs.push("--", request.command, ...request.args);

  const child = spawn("bwrap", sandboxArgs, {
    detached: true,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const maximum = request.maxOutputBytes ?? 1_048_576;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputExceeded = false;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= maximum) target.push(chunk);
    else if (!outputExceeded) {
      outputExceeded = true;
      if (child.pid === undefined) child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    }
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (outputExceeded) {
        reject(new Error("sandbox.output_limit_exceeded"));
        return;
      }
      resolve({
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}
