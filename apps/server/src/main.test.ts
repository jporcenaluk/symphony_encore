import { describe, expect, it, vi } from "vitest";

import { createDeferredShutdown, installShutdownHandlers } from "./main.js";

describe("production process entrypoint", () => {
  it("closes the service exactly once across termination signals", async () => {
    const handlers = new Map<string, () => void>();
    const close = vi.fn(async () => undefined);
    installShutdownHandlers(close, (signal, handler) => handlers.set(signal, handler));

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("honors a termination signal received before service startup completes", async () => {
    const close = vi.fn(async () => undefined);
    const shutdown = createDeferredShutdown();

    await shutdown.request();
    expect(close).not.toHaveBeenCalled();
    await shutdown.attach(close);

    expect(close).toHaveBeenCalledOnce();
    await expect(shutdown.attach(vi.fn(async () => undefined))).rejects.toThrow(
      "shutdown.service_already_attached",
    );
    await shutdown.request();
    expect(close).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent termination requests and preserves shutdown failure", async () => {
    const failure = new Error("close failed");
    const close = vi.fn(async () => {
      throw failure;
    });
    const shutdown = createDeferredShutdown();
    await shutdown.attach(close);

    const first = shutdown.request();
    const second = shutdown.request();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
