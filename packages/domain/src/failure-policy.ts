export type FailureClass =
  | "infrastructure"
  | "agent_process"
  | "configuration"
  | "auth"
  | "policy"
  | "task";

export interface FailureRouteInput {
  baseBackoffMs: number;
  elapsedInfrastructureFailureMs: number;
  failureClass: FailureClass;
  jitterSample: number;
  maxBackoffMs: number;
  maxFailureRetries: number;
  retryAfterMs: number | null;
  retryNumber: number;
}

export type FailureRoute =
  | { delayMs: number; notifyPersistent: boolean; route: "retry" }
  | { reason: "failure.agent_retries_exhausted"; route: "human" }
  | { reason: "failure.configuration" | "failure.auth"; route: "pause_scope" }
  | { emitLesson: true; reason: "failure.policy"; route: "deny" }
  | { reason: "failure.task"; route: "outcome" };

function infrastructureDelay(input: FailureRouteInput): number {
  if (
    input.baseBackoffMs < 0 ||
    input.maxBackoffMs < 0 ||
    input.retryNumber < 1 ||
    input.jitterSample < 0 ||
    input.jitterSample > 1
  ) {
    throw new Error("failure.invalid_backoff_input");
  }
  const exponential = input.baseBackoffMs * 2 ** (input.retryNumber - 1);
  const jittered = exponential * (0.5 + input.jitterSample);
  const bounded = Math.min(input.maxBackoffMs, Math.round(jittered));
  return Math.max(bounded, input.retryAfterMs ?? 0);
}

export function decideFailureRoute(input: FailureRouteInput): FailureRoute {
  switch (input.failureClass) {
    case "infrastructure":
      return {
        delayMs: infrastructureDelay(input),
        notifyPersistent: input.elapsedInfrastructureFailureMs > 3_600_000,
        route: "retry",
      };
    case "agent_process":
      return input.retryNumber <= input.maxFailureRetries
        ? { delayMs: 0, notifyPersistent: false, route: "retry" }
        : { reason: "failure.agent_retries_exhausted", route: "human" };
    case "configuration":
      return { reason: "failure.configuration", route: "pause_scope" };
    case "auth":
      return { reason: "failure.auth", route: "pause_scope" };
    case "policy":
      return { emitLesson: true, reason: "failure.policy", route: "deny" };
    case "task":
      return { reason: "failure.task", route: "outcome" };
  }
}
