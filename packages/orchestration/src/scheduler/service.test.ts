import { describe, expect, it, vi } from "vitest";

import type { IntervalSchedule, IntervalScheduler } from "../runtime-services.js";
import { SchedulerService } from "./service.js";

class TestIntervalScheduler implements IntervalScheduler {
  private readonly scheduled: Array<{
    cancelled: boolean;
    input: IntervalSchedule;
  }> = [];

  get capturedSchedules(): readonly IntervalSchedule[] {
    return this.scheduled.map((entry) => entry.input);
  }

  get intervals() {
    return this.scheduled.map((entry) => ({
      cancel: () => {
        entry.cancelled = true;
      },
      async fire() {
        if (entry.cancelled) return;
        try {
          await entry.input.task();
        } catch (error) {
          entry.input.onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
    }));
  }

  schedule(input: IntervalSchedule) {
    const entry = { cancelled: false, input };
    this.scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }
}

describe("scheduler service", () => {
  it("runs the first tick immediately and routes interval failures", async () => {
    const intervals = new TestIntervalScheduler();
    const onError = vi.fn();
    const tick = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("tick failed"));
    const service = new SchedulerService({ intervalMs: 30_000, intervals, onError, tick });

    await service.start();
    expect(tick).toHaveBeenCalledOnce();
    await intervals.intervals[0]?.fire();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "tick failed" }));
  });

  it("serializes ticks and coalesces concurrent triggers", async () => {
    const intervals = new TestIntervalScheduler();
    const releases: Array<() => void> = [];
    let running = 0;
    let maximumRunning = 0;
    const tick = vi.fn(async () => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    });
    const service = new SchedulerService({ intervalMs: 30_000, intervals, tick });

    const started = service.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
    const firstManual = service.trigger();
    const secondManual = service.trigger();
    const interval = intervals.intervals[0]?.fire();
    releases.shift()?.();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await Promise.all([started, firstManual, secondManual, interval]);

    expect(maximumRunning).toBe(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("close cancels future interval work and waits for active work", async () => {
    const intervals = new TestIntervalScheduler();
    let release: (() => void) | undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const service = new SchedulerService({ intervalMs: 30_000, intervals, tick });

    const started = service.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
    let closed = false;
    const closing = service.close().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);

    release?.();
    await Promise.all([started, closing]);
    await intervals.intervals[0]?.fire();
    expect(tick).toHaveBeenCalledOnce();
    await expect(service.trigger()).rejects.toThrow("scheduler.closed");
  });

  it("treats a fired interval as active before close can complete", async () => {
    const intervals = new TestIntervalScheduler();
    let release: (() => void) | undefined;
    const tick = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const service = new SchedulerService({ intervalMs: 30_000, intervals, tick });
    await service.start();

    const firing = intervals.intervals[0]?.fire();
    expect(tick).toHaveBeenCalledTimes(2);
    let closed = false;
    const closing = service.close().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);

    release?.();
    await Promise.all([firing, closing]);
  });

  it("ignores an interval callback captured before cancellation when it arrives after close", async () => {
    const intervals = new TestIntervalScheduler();
    const tick = vi.fn(async () => undefined);
    const service = new SchedulerService({ intervalMs: 30_000, intervals, tick });
    await service.start();
    const lateTask = intervals.capturedSchedules[0]?.task;

    await service.close();
    await lateTask?.();

    expect(tick).toHaveBeenCalledOnce();
  });
});
