import { describe, expect, it } from "vitest";

import type {
  Clock,
  DeterministicRuntimeServices,
  IdentifierSource,
  IntervalScheduler,
  JitterSource,
} from "./runtime-services.js";

describe("deterministic runtime service contracts", () => {
  it("keeps wall-clock, monotonic, identifier, jitter, and interval capabilities explicit", () => {
    const clock: Clock = {
      monotonicMs: () => 17,
      wallEpochMs: () => 1_721_040_000_000,
      wallIso: () => "2024-07-15T12:00:00.000Z",
    };
    const identifiers: IdentifierSource = { nextId: () => "id-1" };
    const jitter: JitterSource = { sample: () => 0.25 };
    const intervals: IntervalScheduler = {
      schedule: () => ({ cancel: () => undefined }),
    };
    const services: DeterministicRuntimeServices = {
      clock,
      identifiers,
      intervals,
      jitter,
    };

    expect(services.clock.wallIso()).toBe("2024-07-15T12:00:00.000Z");
    expect(services.clock.wallEpochMs()).toBe(1_721_040_000_000);
    expect(services.clock.monotonicMs()).toBe(17);
    expect(services.identifiers.nextId()).toBe("id-1");
    expect(services.jitter.sample()).toBe(0.25);
  });
});
