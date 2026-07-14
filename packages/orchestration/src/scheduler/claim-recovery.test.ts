import type { Claim } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { rehydrateClaims } from "./claim-recovery.js";

function claim(mode: Claim["mode"], id: string): Claim {
  const common = {
    acquired_at: "2026-07-13T10:00:00Z",
    approval_request_id: mode === "AwaitingHuman" ? "approval-1" : null,
    blocker_predicate: mode === "AwaitingHuman" ? "dependency:done" : null,
    holder: "service-1",
    last_comment_cursor: mode === "AwaitingHuman" ? "cursor-9" : null,
    origin_stage: "Todo",
    question_id: mode === "AwaitingHuman" ? "question-1" : null,
    reason: "test",
    updated_at: "2026-07-13T10:00:00Z",
    work_ref: { issue_id: id },
  };
  if (mode === "Running") {
    return {
      ...common,
      expires_at: "2026-07-13T10:01:00Z",
      mode,
      retry_due_at: null,
    };
  }
  if (mode === "RetryQueued") {
    return {
      ...common,
      expires_at: null,
      mode,
      retry_due_at: "2026-07-13T10:05:00Z",
    };
  }
  return { ...common, expires_at: null, mode, retry_due_at: null };
}

describe("claim recovery rehydration", () => {
  it("restores running ownership, ready actions, retry timers, and parked observers", async () => {
    const calls: Array<{ action: string; value: unknown }> = [];
    await rehydrateClaims(
      {
        awaitingHuman: [claim("AwaitingHuman", "human")],
        ready: [claim("Ready", "ready")],
        retries: [{ claim: claim("RetryQueued", "retry"), delayMs: 180_000 }],
        running: [{ claim: claim("Running", "running"), expired: true }],
      },
      {
        enqueueReady: async (value) => calls.push({ action: "ready", value }),
        recoverRunning: async (value) => calls.push({ action: "running", value }),
        registerAwaitingHuman: async (value) => calls.push({ action: "human", value }),
        scheduleRetry: async (value, delayMs) =>
          calls.push({ action: "retry", value: { claim: value, delayMs } }),
      },
    );

    expect(calls.map((call) => call.action)).toEqual(["running", "ready", "retry", "human"]);
    expect(calls[2]?.value).toMatchObject({ delayMs: 180_000 });
    expect(calls[3]?.value).toMatchObject({
      approval_request_id: "approval-1",
      blocker_predicate: "dependency:done",
      last_comment_cursor: "cursor-9",
      question_id: "question-1",
    });
  });
});
