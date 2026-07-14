import type {
  Clock,
  DeterministicRuntimeServices,
  IdentifierSource,
  IntervalCancellation,
  IntervalSchedule,
  IntervalScheduler,
  JitterSource,
} from "@symphony/orchestration";

interface DeterministicClockInput {
  monotonicMs: number;
  wallEpochMs: number;
}

export class DeterministicClock implements Clock {
  private monotonicValue: number;
  private wallEpochValue: number;

  constructor(input: DeterministicClockInput) {
    assertFinite(input.wallEpochMs, "runtime.clock.invalid_wall_time");
    assertFinite(input.monotonicMs, "runtime.clock.invalid_monotonic_time");
    this.wallEpochValue = input.wallEpochMs;
    this.monotonicValue = input.monotonicMs;
  }

  advanceMonotonic(milliseconds: number): void {
    assertFinite(milliseconds, "runtime.clock.invalid_monotonic_advance");
    if (milliseconds < 0) throw new Error("runtime.clock.negative_monotonic_advance");
    this.monotonicValue += milliseconds;
  }

  advanceWall(milliseconds: number): void {
    assertFinite(milliseconds, "runtime.clock.invalid_wall_advance");
    this.wallEpochValue += milliseconds;
  }

  monotonicMs(): number {
    return this.monotonicValue;
  }

  wallEpochMs(): number {
    return this.wallEpochValue;
  }

  wallIso(): string {
    return new Date(this.wallEpochValue).toISOString();
  }
}

export class SequenceIdentifierSource implements IdentifierSource {
  private readonly values: readonly string[];
  private offset = 0;

  constructor(values: readonly string[]) {
    this.values = Object.freeze([...values]);
  }

  nextId(): string {
    const value = this.values[this.offset];
    if (value === undefined) throw new Error("runtime.identifiers.exhausted");
    this.offset += 1;
    return value;
  }
}

export class SequenceJitterSource implements JitterSource {
  private readonly values: readonly number[];
  private offset = 0;

  constructor(values: readonly number[]) {
    for (const value of values) {
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new Error("runtime.jitter.invalid_sample");
      }
    }
    this.values = Object.freeze([...values]);
  }

  sample(): number {
    const value = this.values[this.offset];
    if (value === undefined) throw new Error("runtime.jitter.exhausted");
    this.offset += 1;
    return value;
  }
}

export class ManualInterval implements IntervalCancellation {
  private cancelled = false;
  private readonly input: IntervalSchedule;

  constructor(input: IntervalSchedule) {
    this.input = input;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async fire(): Promise<void> {
    if (this.cancelled) return;
    try {
      await this.input.task();
    } catch (error) {
      this.input.onError(asError(error));
    }
  }
}

export class ManualIntervalScheduler implements IntervalScheduler {
  private readonly scheduled: ManualInterval[] = [];

  get intervals(): readonly ManualInterval[] {
    return Object.freeze([...this.scheduled]);
  }

  schedule(input: IntervalSchedule): ManualInterval {
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1) {
      throw new Error("runtime.intervals.invalid_interval");
    }
    const interval = new ManualInterval(input);
    this.scheduled.push(interval);
    return interval;
  }
}

export function createDeterministicRuntimeServices(input: {
  ids: readonly string[];
  jitter: readonly number[];
  monotonicMs: number;
  wallEpochMs: number;
}): DeterministicRuntimeServices {
  return {
    clock: new DeterministicClock(input),
    identifiers: new SequenceIdentifierSource(input.ids),
    intervals: new ManualIntervalScheduler(),
    jitter: new SequenceJitterSource(input.jitter),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertFinite(value: number, code: string): void {
  if (!Number.isFinite(value)) throw new Error(code);
}
