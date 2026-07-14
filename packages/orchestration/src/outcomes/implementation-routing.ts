type ImplementationStatus =
  | "blocked"
  | "budget_exhausted"
  | "completed"
  | "failed"
  | "needs_input"
  | "needs_rework"
  | "no_progress"
  | "plan_ready";

export interface ImplementationRouteInput {
  agentVerificationPassed: boolean | null;
  maxReworkCycles: number;
  noProgressCount: number;
  reworkCycle: number;
  status: ImplementationStatus;
  workKind: "issue" | "repair_system_job";
}

type ClaimMode = "AwaitingHuman" | "Ready";

export type ImplementationRoute =
  | { reason: "result.completed_without_passing_agent_verification"; route: "failure" }
  | { route: "independent_verification"; successTarget: "Review" | "review" }
  | { route: "dispatch_plan_review" }
  | { claimMode: ClaimMode; route: "retry_fresh" }
  | {
      claimMode: ClaimMode;
      reason?: "blocked" | "budget_exhausted" | "human_review" | "needs_input" | "no_progress";
      route: "issue_lane";
      target: "Human" | "In Progress";
    }
  | {
      claimMode: ClaimMode;
      reason?: "blocked" | "budget_exhausted" | "needs_input" | "no_progress";
      route: "system_job_stage";
      target: "budget_exhausted" | "human" | "rework";
    }
  | { route: "classify_failure" };

export function routeImplementationOutcome(input: ImplementationRouteInput): ImplementationRoute {
  if (input.status === "completed") {
    return input.agentVerificationPassed === true
      ? {
          route: "independent_verification",
          successTarget: input.workKind === "issue" ? "Review" : "review",
        }
      : { reason: "result.completed_without_passing_agent_verification", route: "failure" };
  }
  if (input.status === "plan_ready") return { route: "dispatch_plan_review" };
  if (input.status === "failed") return { route: "classify_failure" };

  if (input.workKind === "repair_system_job") {
    if (input.status === "needs_rework") {
      return { claimMode: "Ready", route: "system_job_stage", target: "rework" };
    }
    if (input.status === "budget_exhausted") {
      return {
        claimMode: "AwaitingHuman",
        reason: "budget_exhausted",
        route: "system_job_stage",
        target: "budget_exhausted",
      };
    }
    return {
      claimMode: "AwaitingHuman",
      reason: input.status,
      route: "system_job_stage",
      target: "human",
    };
  }

  if (input.status === "needs_rework") {
    return input.reworkCycle >= input.maxReworkCycles
      ? {
          claimMode: "AwaitingHuman",
          reason: "human_review",
          route: "issue_lane",
          target: "Human",
        }
      : { claimMode: "Ready", route: "issue_lane", target: "In Progress" };
  }
  if (input.status === "no_progress" && input.noProgressCount < 1) {
    return { claimMode: "Ready", route: "retry_fresh" };
  }
  return {
    claimMode: "AwaitingHuman",
    reason: input.status,
    route: "issue_lane",
    target: "Human",
  };
}
