import { describe, expect, it, vi } from "vitest";

import { SchedulerService } from "./service.js";

describe("scheduler service", () => {
  it("runs an immediate tick, coalesces triggers, and closes the interval", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const service = new SchedulerService({ intervalMs: 30_000, tick });

    const started = service.start();
    await started;
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await service.trigger();
    expect(tick).toHaveBeenCalledTimes(3);
    await service.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
    await expect(service.trigger()).rejects.toThrow("scheduler.closed");
    vi.useRealTimers();
  });
});
