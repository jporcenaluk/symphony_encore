import { PollLoop } from "./poll-loop.js";

export interface SchedulerServiceInput {
  intervalMs: number;
  onError?: (error: Error) => void;
  tick: () => Promise<unknown>;
}

export class SchedulerService {
  private closed = false;
  private readonly intervalMs: number;
  private readonly loop: PollLoop;
  private readonly onError: (error: Error) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: SchedulerServiceInput) {
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1) {
      throw new Error("scheduler.invalid_interval");
    }
    this.intervalMs = input.intervalMs;
    this.loop = new PollLoop(input.tick);
    this.onError = input.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("scheduler.closed");
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.loop.trigger().catch((error: unknown) => this.onError(asError(error)));
    }, this.intervalMs);
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
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.loop.waitForIdle();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
