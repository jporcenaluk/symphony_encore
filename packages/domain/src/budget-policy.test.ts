import { describe, expect, it } from "vitest";

import {
  applyAbsoluteUsage,
  decideReservation,
  estimateUsage,
  nearestRankPercentile,
} from "./budget-policy.js";

describe("absolute usage accounting", () => {
  it("counts only the increase from the last durable absolute totals", () => {
    expect(
      applyAbsoluteUsage(
        { inputTokens: 100, outputTokens: 20 },
        { inputTokens: 145, outputTokens: 35 },
      ),
    ).toEqual({
      delta: { inputTokens: 45, outputTokens: 15, totalTokens: 60 },
      latest: { inputTokens: 145, outputTokens: 35 },
    });
  });

  it("does not double-count repeated or out-of-order events", () => {
    expect(
      applyAbsoluteUsage(
        { inputTokens: 145, outputTokens: 35 },
        { inputTokens: 100, outputTokens: 20 },
      ),
    ).toEqual({
      delta: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latest: { inputTokens: 145, outputTokens: 35 },
    });
  });
});

describe("history-based estimates", () => {
  it("uses nearest-rank p75", () => {
    expect(nearestRankPercentile([100, 200, 300, 400], 0.75)).toBe(300);
  });

  it("uses configured estimate before enough samples and never estimates below it", () => {
    expect(
      estimateUsage({
        configuredEstimate: 200,
        history: [500, 600],
        historyMinSamples: 3,
        historyWindowSamples: 5,
      }),
    ).toBe(200);
    expect(
      estimateUsage({
        configuredEstimate: 200,
        history: [100, 150, 250, 400, 500, 600],
        historyMinSamples: 3,
        historyWindowSamples: 5,
      }),
    ).toBe(500);
  });
});

describe("reservation decisions", () => {
  it("allows all requested ledgers atomically when each has room", () => {
    expect(
      decideReservation([
        { id: "attempt", remaining: 100, requested: 80 },
        { id: "issue", remaining: 200, requested: 80 },
        { id: "fleet", remaining: 500, requested: 80 },
      ]),
    ).toEqual({ allow: true });
  });

  it("rejects the entire reservation and names every exhausted ledger", () => {
    expect(
      decideReservation([
        { id: "attempt", remaining: 100, requested: 80 },
        { id: "issue", remaining: 50, requested: 80 },
        { id: "fleet", remaining: 70, requested: 80 },
      ]),
    ).toEqual({ allow: false, exhaustedLedgerIds: ["issue", "fleet"] });
  });
});
