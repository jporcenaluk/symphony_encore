import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectLinuxProcessOwnership,
  terminateLinuxProcessGroup,
} from "./linux-process-ownership.js";

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
});

describe.runIf(process.platform === "linux")("Linux process ownership", () => {
  it("verifies and terminates the complete recorded process group", async () => {
    const child = spawn("/bin/bash", ["-c", "sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    const processId = await requireProcessId(child);

    await expect(
      inspectLinuxProcessOwnership({ processGroupId: processId, processId }),
    ).resolves.toEqual({ kind: "owned", processGroupId: processId, processId });
    await expect(
      terminateLinuxProcessGroup({
        killWaitMs: 1_000,
        processGroupId: processId,
        processId,
        terminateWaitMs: 50,
      }),
    ).resolves.toMatchObject({ outcome: "terminated" });
    await expect(
      inspectLinuxProcessOwnership({ processGroupId: processId, processId }),
    ).resolves.toEqual({ kind: "no_session" });
  });

  it("refuses to signal a process whose recorded group does not match", async () => {
    const child = spawn("/bin/bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    children.push(child);
    const processId = await requireProcessId(child);

    await expect(
      terminateLinuxProcessGroup({
        killWaitMs: 100,
        processGroupId: processId + 1,
        processId,
        terminateWaitMs: 10,
      }),
    ).rejects.toThrow("process.ownership_mismatch");
    expect(child.exitCode).toBeNull();
  });

  it("escalates to SIGKILL when the process group ignores SIGTERM", async () => {
    const child = spawn("/bin/bash", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    const processId = await requireProcessId(child);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      terminateLinuxProcessGroup({
        killWaitMs: 1_000,
        processGroupId: processId,
        processId,
        terminateWaitMs: 10,
      }),
    ).resolves.toMatchObject({ outcome: "killed" });
  });
});

async function requireProcessId(child: ChildProcess): Promise<number> {
  if (child.pid !== undefined) return child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("test child pid missing");
  return child.pid;
}
