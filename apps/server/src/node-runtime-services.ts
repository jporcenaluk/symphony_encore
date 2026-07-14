import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DeterministicRuntimeServices, IntervalSchedule } from "@symphony/orchestration";

export function createNodeRuntimeServices(): DeterministicRuntimeServices {
  return {
    clock: {
      monotonicMs: () => performance.now(),
      wallEpochMs: () => Date.now(),
      wallIso: () => new Date().toISOString(),
    },
    identifiers: { nextId: randomUUID },
    intervals: {
      schedule(input: IntervalSchedule) {
        const timer = setInterval(() => {
          try {
            void input.task().catch((error: unknown) => input.onError(asError(error)));
          } catch (error) {
            input.onError(asError(error));
          }
        }, input.intervalMs);
        return { cancel: () => clearInterval(timer) };
      },
    },
    jitter: { sample: Math.random },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
