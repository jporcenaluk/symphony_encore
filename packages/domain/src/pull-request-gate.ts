export interface PullRequestGateSnapshot {
  baseRef: string;
  checks: readonly {
    conclusion: string | null;
    name: string;
    requiredSource?: "configured" | "protection" | "union";
    status: string;
    targetSha: string;
  }[];
  headSha: string;
  isDraft: boolean;
  mergeable: boolean | null;
  observedBaseSha: string;
  prState: "open" | "closed" | "merged";
  reviewDecision: "approved" | "changes_requested" | "none";
  unresolvedThreads: readonly { commitSha: string; id: string; isOutdated: boolean }[];
}

export interface PullRequestGateOptions {
  acceptedCheckConclusions: readonly string[];
  expectedBaseRef: string;
  expectedBaseSha: string;
  expectedHeadSha: string;
  quietPeriodSatisfied: boolean;
  requiredChecks: readonly string[];
}

export type PullRequestGateDecision =
  | { decision: "allow" }
  | { decision: "deny" | "update_required" | "wait"; reason: string };

export function evaluatePullRequestGate(
  snapshot: PullRequestGateSnapshot,
  options: PullRequestGateOptions,
): PullRequestGateDecision {
  if (snapshot.headSha !== options.expectedHeadSha) {
    return { decision: "deny", reason: "pull_request.head_mismatch" };
  }
  if (snapshot.baseRef !== options.expectedBaseRef) {
    return { decision: "deny", reason: "pull_request.base_ref_mismatch" };
  }
  if (snapshot.observedBaseSha !== options.expectedBaseSha) {
    return { decision: "update_required", reason: "pull_request.base_advanced" };
  }
  if (snapshot.prState !== "open") {
    return { decision: "deny", reason: `pull_request.${snapshot.prState}` };
  }
  if (snapshot.isDraft) return { decision: "deny", reason: "pull_request.draft" };
  if (snapshot.mergeable === null) {
    return { decision: "wait", reason: "pull_request.mergeability_pending" };
  }
  if (!snapshot.mergeable) {
    return { decision: "deny", reason: "pull_request.not_mergeable" };
  }
  if (snapshot.reviewDecision === "changes_requested") {
    return { decision: "deny", reason: "pull_request.changes_requested" };
  }
  const unresolved = snapshot.unresolvedThreads
    .filter((thread) => !thread.isOutdated)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (unresolved) {
    return { decision: "deny", reason: `pull_request.thread_unresolved:${unresolved.id}` };
  }

  const requiredChecks = new Set(options.requiredChecks);
  for (const check of snapshot.checks) {
    if (check.requiredSource !== undefined) requiredChecks.add(check.name);
  }
  const acceptedConclusions = new Set(
    options.acceptedCheckConclusions.map((conclusion) => conclusion.toLocaleLowerCase("en-US")),
  );
  for (const name of [...requiredChecks].sort((left, right) => left.localeCompare(right))) {
    const named = snapshot.checks.filter((check) => check.name === name);
    if (named.length === 0) {
      return { decision: "wait", reason: `pull_request.check_missing:${name}` };
    }
    const current = named.filter((check) => check.targetSha === options.expectedHeadSha);
    if (current.length === 0) {
      return { decision: "deny", reason: `pull_request.check_stale:${name}` };
    }
    if (current.length !== 1) {
      return { decision: "deny", reason: `pull_request.check_ambiguous:${name}` };
    }
    const check = current[0];
    if (!check) return { decision: "wait", reason: `pull_request.check_missing:${name}` };
    if (check.status.toLocaleLowerCase("en-US") !== "completed" || check.conclusion === null) {
      return { decision: "wait", reason: `pull_request.check_pending:${name}` };
    }
    const conclusion = check.conclusion.toLocaleLowerCase("en-US");
    if (!acceptedConclusions.has(conclusion)) {
      return {
        decision: "deny",
        reason: `pull_request.check_failed:${name}:${conclusion}`,
      };
    }
  }
  if (!options.quietPeriodSatisfied) {
    return { decision: "wait", reason: "pull_request.quiet_period_pending" };
  }
  return { decision: "allow" };
}
