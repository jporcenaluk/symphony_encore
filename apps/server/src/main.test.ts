import { describe, expect, it, vi } from "vitest";

import { installShutdownHandlers } from "./main.js";

describe("production process entrypoint", () => {
  it("closes the service exactly once across termination signals", async () => {
    const handlers = new Map<string, () => void>();
    const close = vi.fn(async () => undefined);
    installShutdownHandlers(close, (signal, handler) => handlers.set(signal, handler));

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
