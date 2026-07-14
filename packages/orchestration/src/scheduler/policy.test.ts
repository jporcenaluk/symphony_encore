import type { Issue } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { evaluateIssueEligibility, sortIssueCandidates } from "./policy.js";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    acceptance_criteria: ["works"],
    assignee_id: "agent-1",
    blocked_by: [],
    created_at: "2026-07-13T10:00:00Z",
    description: "Description",
    id: "1",
    identifier: "ISSUE-1",
    labels: ["symphony-ready", "backend"],
    priority: 1,
    repo_name: "repo",
    repo_owner: "owner",
    state: "Todo",
    title: "Title",
    updated_at: "2026-07-13T10:00:00Z",
    url: "https://example.test/issues/1",
    ...overrides,
  };
}

describe("scheduler issue eligibility", () => {
  it("requires exact assignee, all labels, Todo, terminal blockers, no claim, a slot, and preflight", () => {
    const base = {
      availableSlots: 1,
      configuredAssignee: "agent-1",
      issue: issue(),
      preflightPassed: true,
      requiredLabels: ["symphony-ready", "backend"],
      workClaimed: false,
    };
    expect(evaluateIssueEligibility(base)).toEqual({ eligible: true });
    expect(
      evaluateIssueEligibility({ ...base, issue: issue({ assignee_id: "someone-else" }) }),
    ).toEqual({ eligible: false, reason: "eligibility.assignee_mismatch" });
    expect(evaluateIssueEligibility({ ...base, requiredLabels: ["missing"] })).toEqual({
      eligible: false,
      reason: "eligibility.required_label_missing",
    });
    expect(evaluateIssueEligibility({ ...base, issue: issue({ state: "Review" }) })).toEqual({
      eligible: false,
      reason: "eligibility.lane_not_dispatchable",
    });
    expect(
      evaluateIssueEligibility({
        ...base,
        issue: issue({ blocked_by: [{ id: "2", state: "In Progress" }] }),
      }),
    ).toEqual({ eligible: false, reason: "eligibility.blocked" });
    expect(evaluateIssueEligibility({ ...base, workClaimed: true })).toEqual({
      eligible: false,
      reason: "eligibility.claimed",
    });
    expect(evaluateIssueEligibility({ ...base, availableSlots: 0 })).toEqual({
      eligible: false,
      reason: "eligibility.no_slot",
    });
    expect(evaluateIssueEligibility({ ...base, preflightPassed: false })).toEqual({
      eligible: false,
      reason: "eligibility.preflight_failed",
    });
  });

  it("accepts every normalized terminal blocker state and rejects blank required labels", () => {
    const candidate = issue({
      blocked_by: [
        { id: "2", state: "Done" },
        { id: "3", state: "closed" },
        { id: "4", state: "CANCELLED" },
        { id: "5", state: "Duplicate" },
      ],
    });
    expect(
      evaluateIssueEligibility({
        availableSlots: 1,
        configuredAssignee: null,
        issue: candidate,
        preflightPassed: true,
        requiredLabels: [],
        workClaimed: false,
      }),
    ).toEqual({ eligible: true });
    expect(() =>
      evaluateIssueEligibility({
        availableSlots: 1,
        configuredAssignee: null,
        issue: candidate,
        preflightPassed: true,
        requiredLabels: [" "],
        workClaimed: false,
      }),
    ).toThrow("configuration.blank_required_label");
  });
});

describe("scheduler candidate order", () => {
  it("sorts by priority with null last, then oldest creation time, then identifier", () => {
    const candidates = [
      issue({ created_at: "2026-07-13T09:00:00Z", id: "4", identifier: "ISSUE-4", priority: null }),
      issue({ created_at: "2026-07-13T10:00:00Z", id: "3", identifier: "ISSUE-3", priority: 1 }),
      issue({ created_at: "2026-07-13T09:00:00Z", id: "2", identifier: "ISSUE-2", priority: 1 }),
      issue({ created_at: "2026-07-13T09:00:00Z", id: "1", identifier: "ISSUE-1", priority: 1 }),
      issue({ created_at: "2026-07-13T11:00:00Z", id: "5", identifier: "ISSUE-5", priority: 0 }),
    ];

    expect(sortIssueCandidates(candidates).map((candidate) => candidate.identifier)).toEqual([
      "ISSUE-5",
      "ISSUE-1",
      "ISSUE-2",
      "ISSUE-3",
      "ISSUE-4",
    ]);
    expect(candidates[0]?.identifier).toBe("ISSUE-4");
  });
});
