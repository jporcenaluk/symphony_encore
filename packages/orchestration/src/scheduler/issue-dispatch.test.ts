import { describe, expect, it, vi } from "vitest";

import { dispatchIssue } from "./issue-dispatch.js";
import { PersistenceSafetyController } from "./persistence-safety.js";

describe("receipt-confirmed issue dispatch", () => {
  it("persists first, confirms the tracker receipt and stage, then launches", async () => {
    const calls: string[] = [];
    const safety = new PersistenceSafetyController(async () => {
      calls.push("stop-workers");
    });
    const result = await dispatchIssue(
      { attemptId: "attempt-1", issueId: "issue-1" },
      {
        applyLaneIntent: async () => {
          calls.push("apply-lane");
          return {
            providerRequestId: "request-1",
            responsePayloadHash: "sha256:response",
            result: "lane_updated",
            resultRevision: "revision-2",
          };
        },
        confirmLaneReceipt: async () => calls.push("confirm-receipt-stage"),
        launchWorker: async () => {
          calls.push("launch");
          return { processId: 123 };
        },
        markIntentApplying: async () => calls.push("mark-applying"),
        persistDispatch: async () => calls.push("persist"),
        safety,
      },
    );

    expect(calls).toEqual([
      "persist",
      "mark-applying",
      "apply-lane",
      "confirm-receipt-stage",
      "launch",
    ]);
    expect(result).toEqual({ processId: 123 });
  });

  it("never launches when the lane mutation is unconfirmed", async () => {
    const launchWorker = vi.fn();
    const safety = new PersistenceSafetyController(async () => undefined);
    await expect(
      dispatchIssue(
        { attemptId: "attempt-1", issueId: "issue-1" },
        {
          applyLaneIntent: async () => {
            throw new Error("provider unavailable");
          },
          confirmLaneReceipt: async () => undefined,
          launchWorker,
          markIntentApplying: async () => undefined,
          persistDispatch: async () => undefined,
          safety,
        },
      ),
    ).rejects.toThrow("provider unavailable");
    expect(launchWorker).not.toHaveBeenCalled();
    expect(safety.canDispatch()).toBe(true);
  });

  it("latches persistence failure and stops workers before refusing launch", async () => {
    const launchWorker = vi.fn();
    const stopWorkers = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopWorkers);
    await expect(
      dispatchIssue(
        { attemptId: "attempt-1", issueId: "issue-1" },
        {
          applyLaneIntent: async () => ({
            providerRequestId: "request-1",
            responsePayloadHash: "sha256:response",
            result: "lane_updated",
            resultRevision: "revision-2",
          }),
          confirmLaneReceipt: async () => {
            throw new Error("database read only");
          },
          launchWorker,
          markIntentApplying: async () => undefined,
          persistDispatch: async () => undefined,
          safety,
        },
      ),
    ).rejects.toThrow("database read only");
    expect(stopWorkers).toHaveBeenCalledOnce();
    expect(safety.canDispatch()).toBe(false);
    expect(launchWorker).not.toHaveBeenCalled();
  });

  it("latches persistence failure before applying the external intent", async () => {
    const applyLaneIntent = vi.fn();
    const stopWorkers = vi.fn(async () => undefined);
    const safety = new PersistenceSafetyController(stopWorkers);
    await expect(
      dispatchIssue(
        { attemptId: "attempt-1", issueId: "issue-1" },
        {
          applyLaneIntent,
          confirmLaneReceipt: async () => undefined,
          launchWorker: vi.fn(),
          markIntentApplying: async () => {
            throw new Error("sqlite.read_only");
          },
          persistDispatch: async () => undefined,
          safety,
        },
      ),
    ).rejects.toThrow("sqlite.read_only");
    expect(stopWorkers).toHaveBeenCalledOnce();
    expect(applyLaneIntent).not.toHaveBeenCalled();
  });
});
