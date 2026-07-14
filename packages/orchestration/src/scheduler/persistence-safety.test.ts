import { describe, expect, it, vi } from "vitest";

import { PersistenceSafetyController } from "./persistence-safety.js";

describe("persistence failure safety", () => {
  it("latches the first failure, stops workers once, and disables dispatch and mutations", async () => {
    const stopWorkers = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopWorkers);

    expect(safety.canDispatch()).toBe(true);
    expect(safety.canMutateProvider()).toBe(true);
    await safety.recordFailure(new Error("disk full"));
    await safety.recordFailure(new Error("second"));

    expect(safety.canDispatch()).toBe(false);
    expect(safety.canMutateProvider()).toBe(false);
    expect(safety.failure()?.message).toBe("disk full");
    expect(stopWorkers).toHaveBeenCalledTimes(1);
    expect(() => safety.assertDispatchAllowed()).toThrow("persistence.failure_latched");
    expect(() => safety.assertProviderMutationAllowed()).toThrow("persistence.failure_latched");
  });
});
