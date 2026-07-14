import { type ChildProcess, execFile } from "node:child_process";

export interface PosixProcessGroupBinding {
  /** True only while the launch-time supervisor ChildProcess is still the same process. */
  readonly isOriginalSupervisorLive: () => boolean;
  /** The supervisor is spawned as this process group's leader. */
  readonly pgid: number;
}

export interface PosixProcessGroupOperations {
  probeGroup(pgid: number): Promise<"absent" | "present">;
  sendSupervisorSignal(signal: NodeJS.Signals): Promise<void> | void;
  wait(milliseconds: number): Promise<void>;
}

export type PosixProcessTreeErrorCode =
  | "process_tree.identity_ambiguous"
  | "process_tree.signal_denied"
  | "process_tree.signal_failed"
  | "process_tree.verification_failed";

/**
 * The portable boundary is intentionally narrow: only trusted gh/git commands that
 * remain in the launch-time supervisor's process group are contained. A command that
 * deliberately escapes that group by daemonizing or entering another session is outside
 * this boundary; reparented descendants that stay in the group remain contained.
 */
export const POSIX_PROCESS_TREE_TRUST_BOUNDARY =
  "trusted_gh_git_must_remain_in_launch_supervisor_group" as const;

export class PosixProcessTreeError extends Error {
  readonly code: PosixProcessTreeErrorCode;

  constructor(code: PosixProcessTreeErrorCode) {
    super(code);
    this.name = "PosixProcessTreeError";
    this.code = code;
  }
}

/**
 * Terminates only a process group whose identity is still anchored by the supervisor
 * created at launch. It never enumerates or signals descendant PIDs. Once that anchor
 * exits, the numeric PGID is read-only probed and is never signaled again.
 */
export async function terminateBoundPosixProcessGroup(
  binding: PosixProcessGroupBinding,
  options: {
    readonly graceMs?: number;
    readonly operations: PosixProcessGroupOperations;
    readonly pollMs?: number;
    readonly verificationTimeoutMs?: number;
  },
): Promise<void> {
  if (!Number.isSafeInteger(binding.pgid) || binding.pgid <= 0) {
    throw new PosixProcessTreeError("process_tree.signal_failed");
  }
  const graceMs = boundedDuration(options.graceMs ?? 250);
  const pollMs = boundedDuration(options.pollMs ?? 20);
  const verificationTimeoutMs = boundedDuration(options.verificationTimeoutMs ?? 1_000);
  const operations = options.operations;

  if (!binding.isOriginalSupervisorLive()) {
    return verifyUnanchoredGroup(binding.pgid, operations, pollMs, verificationTimeoutMs);
  }
  await sendSupervisorSignal(operations, "SIGTERM");
  await operations.wait(graceMs);

  if (!binding.isOriginalSupervisorLive()) {
    return verifyUnanchoredGroup(binding.pgid, operations, pollMs, verificationTimeoutMs);
  }
  await sendSupervisorSignal(operations, "SIGKILL");

  const deadline = Date.now() + verificationTimeoutMs;
  let supervisorGone = false;
  do {
    await operations.wait(pollMs);
    supervisorGone ||= !binding.isOriginalSupervisorLive();
    if (supervisorGone && (await operations.probeGroup(binding.pgid)) === "absent") return;
  } while (Date.now() < deadline);

  if (supervisorGone) throw new PosixProcessTreeError("process_tree.identity_ambiguous");
  throw new PosixProcessTreeError("process_tree.verification_failed");
}

function boundedDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new PosixProcessTreeError("process_tree.signal_failed");
  }
  return value;
}

async function verifyUnanchoredGroup(
  pgid: number,
  operations: PosixProcessGroupOperations,
  pollMs: number,
  verificationTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + verificationTimeoutMs;
  do {
    if ((await operations.probeGroup(pgid)) === "absent") return;
    await operations.wait(pollMs);
  } while (Date.now() < deadline);
  throw new PosixProcessTreeError("process_tree.identity_ambiguous");
}

async function sendSupervisorSignal(
  operations: PosixProcessGroupOperations,
  signal: NodeJS.Signals,
): Promise<void> {
  try {
    await operations.sendSupervisorSignal(signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      throw new PosixProcessTreeError("process_tree.signal_denied");
    }
    throw new PosixProcessTreeError("process_tree.signal_failed");
  }
}

const DEFAULT_OPERATIONS: PosixProcessGroupOperations = {
  probeGroup(pgid) {
    return probeSystemProcessGroup(pgid);
  },
  sendSupervisorSignal() {
    throw Object.assign(new Error("supervisor unavailable"), { code: "EPERM" });
  },
  wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
};

const SUPERVISOR_SOURCE = String.raw`
const { execFile, spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
let terminating = false;
process.on("SIGTERM", () => { terminating = true; });
process.on("message", (message) => {
  if (message !== "SIGTERM" && message !== "SIGKILL") return;
  terminating = true;
  process.kill(-process.pid, message);
});
const child = spawn(command, args, { env: process.env, stdio: ["inherit", "inherit", "inherit"] });
child.once("error", () => process.exit(127));
child.once("exit", (code) => {
  const exitWhenGroupDrains = () => {
    if (terminating) return;
    const probe = execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], { detached: true, encoding: "utf8", timeout: 500 }, (error, stdout) => {
      if (error) { setTimeout(exitWhenGroupDrains, 20); return; }
      const occupied = String(stdout).split(/\r?\n/u).some((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
        return match && Number(match[1]) !== process.pid && Number(match[1]) !== probe.pid && Number(match[2]) === process.pid && !match[3].startsWith("Z");
      });
      if (occupied) setTimeout(exitWhenGroupDrains, 20);
      else process.exit(code ?? 1);
    });
  };
  exitWhenGroupDrains();
});
`;

export function posixSupervisorInvocation(
  command: string,
  arguments_: readonly string[],
): { readonly arguments: readonly string[]; readonly command: string } {
  return {
    arguments: ["-e", SUPERVISOR_SOURCE, command, ...arguments_],
    command: process.execPath,
  };
}

export function bindPosixSupervisor(child: ChildProcess): {
  readonly binding: PosixProcessGroupBinding;
  readonly operations: PosixProcessGroupOperations;
} {
  if (child.pid === undefined) throw new PosixProcessTreeError("process_tree.signal_failed");
  const pgid = child.pid;
  const isOriginalSupervisorLive = () => child.exitCode === null && child.signalCode === null;
  return {
    binding: { isOriginalSupervisorLive, pgid },
    operations: {
      ...DEFAULT_OPERATIONS,
      async sendSupervisorSignal(signal) {
        await sendBoundSupervisorSignal(child, signal);
      },
    },
  };
}

function sendBoundSupervisorSignal(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      reject(Object.assign(new Error("supervisor unavailable"), { code: "EPERM" }));
      return;
    }
    child.send(signal, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function probeSystemProcessGroup(pgid: number): Promise<"absent" | "present"> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pgid=,stat="],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 2 * 1_048_576,
        timeout: 500,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const present = String(stdout)
          .split(/\r?\n/u)
          .some((line) => {
            const match = /^\s*(\d+)\s+(\S+)/u.exec(line);
            return match !== null && Number(match[1]) === pgid && !match[2]?.startsWith("Z");
          });
        resolve(present ? "present" : "absent");
      },
    );
  });
}
