import type { Issue } from "@symphony/contracts";

export interface IssueEligibilityInput {
  availableSlots: number;
  configuredAssignee: string | null;
  issue: Issue;
  preflightPassed: boolean;
  requiredLabels: readonly string[];
  workClaimed: boolean;
}

export type IssueEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "eligibility.assignee_mismatch"
        | "eligibility.required_label_missing"
        | "eligibility.lane_not_dispatchable"
        | "eligibility.blocked"
        | "eligibility.claimed"
        | "eligibility.no_slot"
        | "eligibility.preflight_failed";
    };

const TERMINAL_BLOCKER_STATES = new Set(["done", "closed", "cancelled", "duplicate"]);

export function evaluateIssueEligibility(input: IssueEligibilityInput): IssueEligibility {
  const requiredLabels = input.requiredLabels.map((label) => {
    const normalized = label.trim().toLocaleLowerCase("en-US");
    if (!normalized) throw new Error("configuration.blank_required_label");
    return normalized;
  });
  if (input.configuredAssignee !== null && input.issue.assignee_id !== input.configuredAssignee) {
    return { eligible: false, reason: "eligibility.assignee_mismatch" };
  }
  const labels = new Set(input.issue.labels);
  if (requiredLabels.some((label) => !labels.has(label))) {
    return { eligible: false, reason: "eligibility.required_label_missing" };
  }
  if (input.issue.state !== "Todo") {
    return { eligible: false, reason: "eligibility.lane_not_dispatchable" };
  }
  if (
    input.issue.blocked_by.some(
      (blocker) => !TERMINAL_BLOCKER_STATES.has(blocker.state.trim().toLocaleLowerCase("en-US")),
    )
  ) {
    return { eligible: false, reason: "eligibility.blocked" };
  }
  if (input.workClaimed) return { eligible: false, reason: "eligibility.claimed" };
  if (input.availableSlots < 1) return { eligible: false, reason: "eligibility.no_slot" };
  if (!input.preflightPassed) return { eligible: false, reason: "eligibility.preflight_failed" };
  return { eligible: true };
}

export function sortIssueCandidates(candidates: readonly Issue[]): Issue[] {
  return [...candidates].sort((left, right) => {
    if (left.priority === null && right.priority !== null) return 1;
    if (left.priority !== null && right.priority === null) return -1;
    if (left.priority !== right.priority) return (left.priority ?? 0) - (right.priority ?? 0);
    const created = Date.parse(left.created_at) - Date.parse(right.created_at);
    if (created !== 0) return created;
    return left.identifier.localeCompare(right.identifier, "en-US");
  });
}
