import { describe, expect, it, vi } from "vitest";

import {
  type PosixProcessGroupBinding,
  type PosixProcessGroupOperations,
  terminateBoundPosixProcessGroup,
} from "./posix-process-tree.js";

describe("bound POSIX process-group termination", () => {
  it("uses only the launch-bound group while its supervisor identity remains live", async () => {
    let live = true;
    const operations = fakeOperations();
    operations.sendSupervisorSignal.mockImplementation((signal) => {
      if (signal === "SIGKILL") live = false;
    });

    await terminateBoundPosixProcessGroup(
      binding(() => live),
      {
        graceMs: 1,
        operations,
        pollMs: 1,
        verificationTimeoutMs: 10,
      },
    );

    expect(operations.sendSupervisorSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("never signals a same-second reused root PID", async () => {
    const operations = fakeOperations("present");

    await expect(
      terminateBoundPosixProcessGroup(
        binding(() => false),
        {
          graceMs: 1,
          operations,
          pollMs: 1,
        },
      ),
    ).rejects.toThrow("process_tree.identity_ambiguous");

    expect(operations.sendSupervisorSignal).not.toHaveBeenCalled();
  });

  it("never enumerates or signals a same-second reused child PID", async () => {
    const operations = fakeOperations();
    operations.sendSupervisorSignal.mockImplementation(() => {
      throw errno("EPERM");
    });

    await expect(
      terminateBoundPosixProcessGroup(
        binding(() => true),
        {
          graceMs: 1,
          operations,
          pollMs: 1,
        },
      ),
    ).rejects.toThrow("process_tree.signal_denied");

    expect(operations.sendSupervisorSignal).toHaveBeenCalledTimes(1);
    expect(operations).not.toHaveProperty("signalGroup");
  });

  it("never signals a root PGID after the bound supervisor has exited and the number is reused", async () => {
    const operations = fakeOperations("present");
    let live = true;
    operations.wait.mockImplementation(async () => {
      live = false;
    });

    await expect(
      terminateBoundPosixProcessGroup(
        binding(() => live),
        {
          graceMs: 1,
          operations,
          pollMs: 1,
        },
      ),
    ).rejects.toThrow("process_tree.identity_ambiguous");

    expect(operations.sendSupervisorSignal.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("accepts an already exited supervisor only when its group is proven absent", async () => {
    const operations = fakeOperations("absent");

    await expect(
      terminateBoundPosixProcessGroup(
        binding(() => false),
        {
          graceMs: 1,
          operations,
          pollMs: 1,
        },
      ),
    ).resolves.toBeUndefined();
    expect(operations.sendSupervisorSignal).not.toHaveBeenCalled();
  });

  it("fails closed when KILL enqueue succeeds, the supervisor exits, and the group remains", async () => {
    let live = true;
    const operations = fakeOperations("present");
    operations.sendSupervisorSignal.mockImplementation((signal) => {
      if (signal === "SIGKILL") live = false;
    });

    await expect(
      terminateBoundPosixProcessGroup(
        binding(() => live),
        {
          graceMs: 1,
          operations,
          pollMs: 1,
          verificationTimeoutMs: 1,
        },
      ),
    ).rejects.toThrow("process_tree.identity_ambiguous");

    expect(operations.sendSupervisorSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});

function binding(isOriginalSupervisorLive: () => boolean): PosixProcessGroupBinding {
  return {
    isOriginalSupervisorLive,
    pgid: 100,
  };
}

function fakeOperations(
  groupState: "absent" | "present" = "absent",
): PosixProcessGroupOperations & {
  probeGroup: ReturnType<typeof vi.fn<PosixProcessGroupOperations["probeGroup"]>>;
  sendSupervisorSignal: ReturnType<
    typeof vi.fn<PosixProcessGroupOperations["sendSupervisorSignal"]>
  >;
  wait: ReturnType<typeof vi.fn<PosixProcessGroupOperations["wait"]>>;
} {
  return {
    probeGroup: vi.fn(async () => groupState),
    sendSupervisorSignal: vi.fn(),
    wait: vi.fn(async () => undefined),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
