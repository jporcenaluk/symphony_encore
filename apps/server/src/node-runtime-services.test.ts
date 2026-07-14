import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeRuntimeServices } from "./node-runtime-services.js";

afterEach(() => vi.useRealTimers());

describe("Node runtime services", () => {
  it("provides wall, monotonic, identifier, jitter, and cancellable interval primitives", async () => {
    const services = createNodeRuntimeServices();
    const beforeWallRead = Date.now();
    const wallIso = Date.parse(services.clock.wallIso());
    const wallEpochMs = services.clock.wallEpochMs();
    const afterWallRead = Date.now();
    expect(wallIso).toBeGreaterThanOrEqual(beforeWallRead);
    expect(wallIso).toBeLessThanOrEqual(afterWallRead);
    expect(wallEpochMs).toBeGreaterThanOrEqual(beforeWallRead);
    expect(wallEpochMs).toBeLessThanOrEqual(afterWallRead);
    expect(services.clock.monotonicMs()).toBeGreaterThanOrEqual(0);
    expect(services.identifiers.nextId()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(services.jitter.sample()).toBeGreaterThanOrEqual(0);
    expect(services.jitter.sample()).toBeLessThan(1);
  });

  it("fires interval tasks and cancellation prevents later executions", async () => {
    vi.useFakeTimers();
    const services = createNodeRuntimeServices();
    const task = vi.fn(async () => undefined);
    const interval = services.intervals.schedule({ intervalMs: 100, onError: vi.fn(), task });

    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledOnce();
    interval.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(task).toHaveBeenCalledOnce();
  });

  it("normalizes and routes synchronous interval task failures", async () => {
    vi.useFakeTimers();
    const services = createNodeRuntimeServices();
    const onError = vi.fn();
    const task = vi.fn(() => {
      throw "synchronous failure";
    }) as unknown as () => Promise<void>;
    const interval = services.intervals.schedule({ intervalMs: 100, onError, task });

    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "synchronous failure" }),
    );
    interval.cancel();
  });

  it("normalizes and routes asynchronous interval task failures", async () => {
    vi.useFakeTimers();
    const services = createNodeRuntimeServices();
    const onError = vi.fn();
    const task = vi.fn(async () => {
      throw "asynchronous failure";
    });
    const interval = services.intervals.schedule({ intervalMs: 100, onError, task });

    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "asynchronous failure" }),
    );
    interval.cancel();
  });
});
