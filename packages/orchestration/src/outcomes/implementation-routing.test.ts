import { describe, expect, it } from "vitest";

import { routeImplementationOutcome } from "./implementation-routing.js";

describe("implementation outcome routing", () => {
  it("requires passing agent evidence before independent verification", () => {
    expect(
      routeImplementationOutcome({
        agentVerificationPassed: false,
        maxReworkCycles: 2,
        noProgressCount: 0,
        reworkCycle: 0,
        status: "completed",
        workKind: "issue",
      }),
    ).toEqual({ reason: "result.completed_without_passing_agent_verification", route: "failure" });
    expect(
      routeImplementationOutcome({
        agentVerificationPassed: true,
        maxReworkCycles: 2,
        noProgressCount: 0,
        reworkCycle: 0,
        status: "completed",
        workKind: "issue",
      }),
    ).toEqual({ route: "independent_verification", successTarget: "Review" });
  });

  it("routes every issue outcome and enforces rework/no-progress caps", () => {
    const base = {
      agentVerificationPassed: null,
      maxReworkCycles: 2,
      noProgressCount: 0,
      reworkCycle: 0,
      workKind: "issue" as const,
    };
    expect(routeImplementationOutcome({ ...base, status: "plan_ready" })).toEqual({
      route: "dispatch_plan_review",
    });
    expect(routeImplementationOutcome({ ...base, reworkCycle: 1, status: "needs_rework" })).toEqual(
      {
        claimMode: "Ready",
        route: "issue_lane",
        target: "In Progress",
      },
    );
    expect(routeImplementationOutcome({ ...base, reworkCycle: 2, status: "needs_rework" })).toEqual(
      {
        claimMode: "AwaitingHuman",
        reason: "human_review",
        route: "issue_lane",
        target: "Human",
      },
    );
    expect(routeImplementationOutcome({ ...base, status: "blocked" })).toEqual({
      claimMode: "AwaitingHuman",
      reason: "blocked",
      route: "issue_lane",
      target: "Human",
    });
    expect(routeImplementationOutcome({ ...base, status: "needs_input" })).toEqual({
      claimMode: "AwaitingHuman",
      reason: "needs_input",
      route: "issue_lane",
      target: "Human",
    });
    expect(routeImplementationOutcome({ ...base, status: "no_progress" })).toEqual({
      claimMode: "Ready",
      route: "retry_fresh",
    });
    expect(
      routeImplementationOutcome({ ...base, noProgressCount: 1, status: "no_progress" }),
    ).toEqual({
      claimMode: "AwaitingHuman",
      reason: "no_progress",
      route: "issue_lane",
      target: "Human",
    });
    expect(routeImplementationOutcome({ ...base, status: "budget_exhausted" })).toEqual({
      claimMode: "AwaitingHuman",
      reason: "budget_exhausted",
      route: "issue_lane",
      target: "Human",
    });
    expect(routeImplementationOutcome({ ...base, status: "failed" })).toEqual({
      route: "classify_failure",
    });
  });

  it("maps repair work to durable SystemJob stages without tracker lanes", () => {
    const base = {
      agentVerificationPassed: null,
      maxReworkCycles: 2,
      noProgressCount: 0,
      reworkCycle: 0,
      workKind: "repair_system_job" as const,
    };
    expect(
      routeImplementationOutcome({ ...base, agentVerificationPassed: true, status: "completed" }),
    ).toEqual({ route: "independent_verification", successTarget: "review" });
    expect(routeImplementationOutcome({ ...base, status: "needs_rework" })).toEqual({
      claimMode: "Ready",
      route: "system_job_stage",
      target: "rework",
    });
    expect(routeImplementationOutcome({ ...base, status: "blocked" })).toEqual({
      claimMode: "AwaitingHuman",
      reason: "blocked",
      route: "system_job_stage",
      target: "human",
    });
  });
});
