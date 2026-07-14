export type IssueLane = "Backlog" | "Todo" | "In Progress" | "Review" | "Human" | "Done";

export type HumanReason =
  | "needs_input"
  | "human_review"
  | "agent_approval"
  | "blocked"
  | "budget_exhausted"
  | "no_progress";

export interface IssueTransitionRequest {
  from: IssueLane;
  humanOrigin?: Exclude<IssueLane, "Human" | "Done" | "Backlog">;
  to: IssueLane;
}

export type TransitionDecision =
  | { allow: true }
  | {
      allow: false;
      reason:
        | "lifecycle.backlog_immutable"
        | "lifecycle.terminal"
        | "lifecycle.human_origin_mismatch"
        | "lifecycle.invalid_transition";
    };

const FORWARD_TRANSITIONS = new Set([
  "Todo->In Progress",
  "In Progress->Review",
  "Review->Done",
  "Review->In Progress",
]);

export function decideIssueTransition(request: IssueTransitionRequest): TransitionDecision {
  if (request.from === "Backlog") {
    return { allow: false, reason: "lifecycle.backlog_immutable" };
  }
  if (request.from === "Done") return { allow: false, reason: "lifecycle.terminal" };
  if (request.from === "Human") {
    return request.humanOrigin === request.to
      ? { allow: true }
      : { allow: false, reason: "lifecycle.human_origin_mismatch" };
  }
  if (request.to === "Human") return { allow: true };
  if (FORWARD_TRANSITIONS.has(`${request.from}->${request.to}`)) return { allow: true };
  return { allow: false, reason: "lifecycle.invalid_transition" };
}
