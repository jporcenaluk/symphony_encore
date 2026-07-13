import { describe, expect, it, vi } from "vitest";

import { PollLoop } from "./poll-loop.js";

describe("poll loop immediate triggers", () => {
  it("serializes ticks and coalesces concurrent triggers into one follow-up tick", async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let maximumRunning = 0;
    const tick = vi.fn(async () => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    });
    const loop = new PollLoop(tick);

    const first = loop.trigger();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    const second = loop.trigger();
    const third = loop.trigger();
    releases.shift()?.();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await Promise.all([first, second, third]);

    expect(maximumRunning).toBe(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
