import { describe, expect, it, vi } from "vitest";

import { waitForHttpReady } from "./runtime-readiness.js";

describe("production runtime readiness polling", () => {
  it("waits through fail-closed recovery and accepts readiness", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("recovering", { status: 503 }))
      .mockResolvedValueOnce(new Response("ready", { status: 200 }));

    await expect(
      waitForHttpReady("http://127.0.0.1:43123", {
        fetchImplementation,
        pollMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected readiness response immediately", async () => {
    await expect(
      waitForHttpReady("http://127.0.0.1:43123", {
        fetchImplementation: vi.fn<typeof fetch>(
          async () => new Response("failed", { status: 500 }),
        ),
        pollMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("runtime readiness returned an unexpected response: 500 failed");
  });

  it("bounds a fetch implementation that never settles", async () => {
    await expect(
      waitForHttpReady("http://127.0.0.1:43123", {
        fetchImplementation: vi.fn<typeof fetch>(() => new Promise(() => undefined)),
        pollMs: 1,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("runtime readiness timed out");
  });
});
