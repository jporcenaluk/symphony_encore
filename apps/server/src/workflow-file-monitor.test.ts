import { describe, expect, it, vi } from "vitest";

import { createWorkflowFileMonitor } from "./workflow-file-monitor.js";

describe("workflow file monitor", () => {
  it("emits each changed source hash once and ignores unchanged polls", async () => {
    let source = "first";
    const onCandidate = vi.fn(
      async (_candidate: { source: string; sourceHash: string }) => undefined,
    );
    const monitor = createWorkflowFileMonitor({
      initialSourceHash: "sha256:initial",
      intervalMs: 60_000,
      onCandidate,
      onReadError: vi.fn(),
      readSource: async () => source,
      startTimer: false,
    });

    await monitor.check();
    await monitor.check();
    source = "second";
    await monitor.check();

    expect(onCandidate).toHaveBeenCalledTimes(2);
    expect(onCandidate.mock.calls[0]?.[0]).toMatchObject({ source: "first" });
    expect(onCandidate.mock.calls[1]?.[0]).toMatchObject({ source: "second" });
    await monitor.close();
  });

  it("reports read failures without changing the last observed candidate", async () => {
    let fail = true;
    const onCandidate = vi.fn(
      async (_candidate: { source: string; sourceHash: string }) => undefined,
    );
    const onReadError = vi.fn();
    const monitor = createWorkflowFileMonitor({
      initialSourceHash: "sha256:initial",
      intervalMs: 60_000,
      onCandidate,
      onReadError,
      readSource: async () => {
        if (fail) throw new Error("unavailable");
        return "next";
      },
      startTimer: false,
    });

    await monitor.check();
    fail = false;
    await monitor.check();

    expect(onReadError).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledOnce();
    await monitor.close();
  });
});
