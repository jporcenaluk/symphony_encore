import { describe, expect, it } from "vitest";

import { decideIssueTransition } from "./issue-lifecycle.js";

describe("issue lifecycle", () => {
  it.each([
    ["Todo", "In Progress"],
    ["In Progress", "Review"],
    ["Review", "Done"],
    ["Review", "In Progress"],
  ] as const)("allows %s to move to %s", (from, to) => {
    expect(decideIssueTransition({ from, to })).toEqual({ allow: true });
  });

  it("rejects direct completion from implementation", () => {
    expect(decideIssueTransition({ from: "In Progress", to: "Done" })).toEqual({
      allow: false,
      reason: "lifecycle.invalid_transition",
    });
  });

  it("allows any active lane to park in Human", () => {
    expect(decideIssueTransition({ from: "Review", to: "Human" })).toEqual({ allow: true });
    expect(decideIssueTransition({ from: "Todo", to: "Human" })).toEqual({ allow: true });
  });

  it("returns Human work only to its recorded origin lane", () => {
    expect(decideIssueTransition({ from: "Human", humanOrigin: "Review", to: "Review" })).toEqual({
      allow: true,
    });
    expect(
      decideIssueTransition({ from: "Human", humanOrigin: "Review", to: "In Progress" }),
    ).toEqual({ allow: false, reason: "lifecycle.human_origin_mismatch" });
  });

  it("never mutates Backlog or terminal work", () => {
    expect(decideIssueTransition({ from: "Backlog", to: "Todo" })).toEqual({
      allow: false,
      reason: "lifecycle.backlog_immutable",
    });
    expect(decideIssueTransition({ from: "Done", to: "Human" })).toEqual({
      allow: false,
      reason: "lifecycle.terminal",
    });
  });
});
