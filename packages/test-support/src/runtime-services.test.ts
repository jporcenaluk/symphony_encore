import { describe, expect, it, vi } from "vitest";

import {
  DeterministicClock,
  ManualIntervalScheduler,
  SequenceIdentifierSource,
  SequenceJitterSource,
} from "./runtime-services.js";

describe("deterministic runtime test support", () => {
  it("advances wall and monotonic time independently", () => {
    const clock = new DeterministicClock({
      monotonicMs: 10,
      wallEpochMs: Date.parse("2026-07-14T12:00:00.000Z"),
    });

    clock.advanceWall(2_000);
    expect(clock.wallIso()).toBe("2026-07-14T12:00:02.000Z");
    expect(clock.wallEpochMs()).toBe(Date.parse("2026-07-14T12:00:02.000Z"));
    expect(clock.monotonicMs()).toBe(10);

    clock.advanceMonotonic(5);
    expect(clock.monotonicMs()).toBe(15);
    expect(clock.wallIso()).toBe("2026-07-14T12:00:02.000Z");
  });

  it("allows zero but rejects negative monotonic advances without changing the clock", () => {
    const clock = new DeterministicClock({ monotonicMs: 10, wallEpochMs: 20 });

    clock.advanceMonotonic(0);
    expect(clock.monotonicMs()).toBe(10);
    expect(() => clock.advanceMonotonic(-1)).toThrow("runtime.clock.negative_monotonic_advance");
    expect(clock.monotonicMs()).toBe(10);
  });

  it("copies identifier input and fails loudly when the sequence is exhausted", () => {
    const ids = ["id-1", "id-2"];
    const source = new SequenceIdentifierSource(ids);
    ids[0] = "mutated";

    expect(source.nextId()).toBe("id-1");
    expect(source.nextId()).toBe("id-2");
    expect(() => source.nextId()).toThrow("runtime.identifiers.exhausted");
  });

  it("validates jitter bounds, copies input, and exhausts loudly", () => {
    expect(() => new SequenceJitterSource([-0.01])).toThrow("runtime.jitter.invalid_sample");
    expect(() => new SequenceJitterSource([1])).toThrow("runtime.jitter.invalid_sample");
    const samples = [0, 0.75];
    const source = new SequenceJitterSource(samples);
    samples[0] = 0.5;

    expect(source.sample()).toBe(0);
    expect(source.sample()).toBe(0.75);
    expect(() => source.sample()).toThrow("runtime.jitter.exhausted");
  });

  it("fires manually, routes asynchronous errors, and ignores cancelled intervals", async () => {
    const scheduler = new ManualIntervalScheduler();
    const onError = vi.fn();
    const task = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("interval failed");
    const interval = scheduler.schedule({ intervalMs: 30_000, onError, task });

    await interval.fire();
    await interval.fire();
    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "interval failed" }));

    interval.cancel();
    await interval.fire();
    expect(task).toHaveBeenCalledTimes(2);
    expect(scheduler.intervals).not.toBe(scheduler.intervals);
    expect(() => scheduler.schedule({ intervalMs: 0, onError, task })).toThrow(
      "runtime.intervals.invalid_interval",
    );
  });
});
