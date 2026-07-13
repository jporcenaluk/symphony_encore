import { readdir, readFile } from "node:fs/promises";

export type LinuxProcessOwnership =
  | { kind: "no_session" }
  | { kind: "owned"; processGroupId: number; processId: number }
  | { kind: "ownership_mismatch"; observedProcessGroupId: number };

export interface LinuxProcessIdentity {
  processGroupId: number;
  processId: number;
}

export async function inspectLinuxProcessOwnership(
  identity: LinuxProcessIdentity,
): Promise<LinuxProcessOwnership> {
  requireSafeIdentity(identity);
  const stat = await readProcessStat(identity.processId);
  if (stat === null || stat.state === "Z") return { kind: "no_session" };
  if (stat.processGroupId !== identity.processGroupId) {
    return { kind: "ownership_mismatch", observedProcessGroupId: stat.processGroupId };
  }
  return { kind: "owned", ...identity };
}

export async function terminateLinuxProcessGroup(
  input: LinuxProcessIdentity & { killWaitMs: number; terminateWaitMs: number },
): Promise<{ outcome: "already_exited" | "killed" | "terminated" }> {
  if (process.platform !== "linux") throw new Error("process.linux_required");
  requireSafeIdentity(input);
  requireWait(input.terminateWaitMs);
  requireWait(input.killWaitMs);
  const current = await readProcessStat(process.pid);
  if (current?.processGroupId === input.processGroupId) {
    throw new Error("process.current_group_protected");
  }
  const ownership = await inspectLinuxProcessOwnership(input);
  if (ownership.kind === "no_session") return { outcome: "already_exited" };
  if (ownership.kind === "ownership_mismatch") throw new Error("process.ownership_mismatch");

  signalProcessGroup(input.processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(input.processGroupId, input.terminateWaitMs)) {
    return { outcome: "terminated" };
  }
  signalProcessGroup(input.processGroupId, "SIGKILL");
  if (!(await waitForProcessGroupExit(input.processGroupId, input.killWaitMs))) {
    throw new Error("process.termination_unconfirmed");
  }
  return { outcome: "killed" };
}

function requireSafeIdentity(identity: LinuxProcessIdentity): void {
  if (
    !Number.isSafeInteger(identity.processId) ||
    !Number.isSafeInteger(identity.processGroupId) ||
    identity.processId <= 1 ||
    identity.processGroupId <= 1
  ) {
    throw new Error("process.invalid_identity");
  }
}

function requireWait(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("process.invalid_wait");
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  do {
    if (!(await hasLiveProcessGroupMember(processGroupId))) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, waitMs))));
  } while (Date.now() <= deadline);
  return !(await hasLiveProcessGroupMember(processGroupId));
}

async function hasLiveProcessGroupMember(processGroupId: number): Promise<boolean> {
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    const stat = await readProcessStat(Number(entry.name));
    if (stat?.processGroupId === processGroupId && stat.state !== "Z") return true;
  }
  return false;
}

async function readProcessStat(
  processId: number,
): Promise<{ processGroupId: number; state: string } | null> {
  try {
    const value = await readFile(`/proc/${processId}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) throw new Error("process.invalid_proc_stat");
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const processGroupId = Number(fields[2]);
    if (state === undefined || !Number.isSafeInteger(processGroupId)) {
      throw new Error("process.invalid_proc_stat");
    }
    return { processGroupId, state };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
