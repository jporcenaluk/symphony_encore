import type { IntervalCancellation, IntervalScheduler } from "../runtime-services.js";
import { PollLoop } from "./poll-loop.js";

export interface SchedulerServiceInput {
  intervalMs: number;
  intervals: IntervalScheduler;
  onError?: (error: Error) => void;
  tick: () => Promise<unknown>;
}

export class SchedulerService {
  private closed = false;
  private readonly intervalMs: number;
  private readonly intervals: IntervalScheduler;
  private readonly loop: PollLoop;
  private readonly onError: (error: Error) => void;
  private timer: IntervalCancellation | null = null;

  constructor(input: SchedulerServiceInput) {
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1) {
      throw new Error("scheduler.invalid_interval");
    }
    this.intervalMs = input.intervalMs;
    this.intervals = input.intervals;
    this.loop = new PollLoop(input.tick);
    this.onError = input.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("scheduler.closed");
    if (this.timer !== null) return;
    this.timer = this.intervals.schedule({
      intervalMs: this.intervalMs,
      onError: this.onError,
      task: () => (this.closed ? Promise.resolve() : this.loop.trigger()),
    });
    await this.loop.trigger();
  }

  trigger(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("scheduler.closed"));
    return this.loop.trigger();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.timer.cancel();
      this.timer = null;
    }
    await this.loop.waitForIdle();
  }
}
