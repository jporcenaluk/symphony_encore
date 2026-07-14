export interface Clock {
  monotonicMs(): number;
  wallEpochMs(): number;
  wallIso(): string;
}

export interface IdentifierSource {
  nextId(): string;
}

export interface JitterSource {
  sample(): number;
}

export interface IntervalCancellation {
  cancel(): void;
}

export interface IntervalSchedule {
  intervalMs: number;
  onError(error: Error): void;
  task(): Promise<void>;
}

export interface IntervalScheduler {
  schedule(input: IntervalSchedule): IntervalCancellation;
}

/**
 * The deterministic primitives extracted in W1a. This is deliberately not a
 * complete inventory of every runtime effect used by orchestration.
 */
export interface DeterministicRuntimeServices {
  clock: Clock;
  identifiers: IdentifierSource;
  intervals: IntervalScheduler;
  jitter: JitterSource;
}
