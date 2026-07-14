import { describe, expect, it } from "vitest";

import { decideFailureRoute } from "./failure-policy.js";

const defaults = {
  baseBackoffMs: 10_000,
  elapsedInfrastructureFailureMs: 0,
  jitterSample: 0.5,
  maxBackoffMs: 300_000,
  maxFailureRetries: 2,
  retryAfterMs: null,
  retryNumber: 1,
};

describe("failure routing", () => {
  it("retries infrastructure failures with bounded jitter and retry-after", () => {
    expect(decideFailureRoute({ ...defaults, failureClass: "infrastructure" })).toEqual({
      delayMs: 10_000,
      notifyPersistent: false,
      route: "retry",
    });
    expect(
      decideFailureRoute({
        ...defaults,
        elapsedInfrastructureFailureMs: 3_600_001,
        failureClass: "infrastructure",
        retryAfterMs: 45_000,
        retryNumber: 3,
      }),
    ).toEqual({ delayMs: 45_000, notifyPersistent: true, route: "retry" });
  });

  it("caps exponential infrastructure delay", () => {
    expect(
      decideFailureRoute({
        ...defaults,
        failureClass: "infrastructure",
        jitterSample: 1,
        retryNumber: 20,
      }),
    ).toEqual({ delayMs: 300_000, notifyPersistent: false, route: "retry" });
  });

  it("bounds agent-process retries per work cycle", () => {
    expect(decideFailureRoute({ ...defaults, failureClass: "agent_process" })).toEqual({
      delayMs: 0,
      notifyPersistent: false,
      route: "retry",
    });
    expect(
      decideFailureRoute({ ...defaults, failureClass: "agent_process", retryNumber: 3 }),
    ).toEqual({ reason: "failure.agent_retries_exhausted", route: "human" });
  });

  it.each(["configuration", "auth"] as const)("pauses the affected %s scope", (failureClass) => {
    expect(decideFailureRoute({ ...defaults, failureClass })).toEqual({
      reason: `failure.${failureClass}`,
      route: "pause_scope",
    });
  });

  it("turns policy failures into lessons and tasks back into outcome routing", () => {
    expect(decideFailureRoute({ ...defaults, failureClass: "policy" })).toEqual({
      emitLesson: true,
      reason: "failure.policy",
      route: "deny",
    });
    expect(decideFailureRoute({ ...defaults, failureClass: "task" })).toEqual({
      reason: "failure.task",
      route: "outcome",
    });
  });
});
