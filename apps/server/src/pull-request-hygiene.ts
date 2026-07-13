import { createHash } from "node:crypto";

import type { PullRequestSnapshot, WorkRef } from "@symphony/contracts";
import {
  evaluatePullRequestGate,
  type PullRequestGateDecision,
  type PullRequestGateSnapshot,
} from "@symphony/domain";
import {
  type OpenedDatabase,
  observePullRequestGateMaterial,
  type PendingPullRequestGate,
  routePullRequestGateDecision,
} from "@symphony/persistence";

export async function runPullRequestHygiene(input: {
  acceptedCheckConclusions: readonly string[];
  database: OpenedDatabase["database"];
  fetchPullRequestSnapshot(workRef: WorkRef): Promise<PullRequestSnapshot>;
  now(): string;
  pollIntervalMs: number;
  quietPeriodMs: number;
  requiredChecks: readonly string[];
  settleTimeoutMs: number;
  target: PendingPullRequestGate;
  workRef: { id: string; kind: "issue" | "system_job" };
}): Promise<PullRequestGateDecision> {
  validateDurations(input);
  const snapshot = await input.fetchPullRequestSnapshot(toContractWorkRef(input.workRef));
  if (
    snapshot.pr_number !== input.target.pullRequestNumber ||
    snapshot.pr_url !== input.target.pullRequestUrl
  ) {
    throw new Error("pull_request_gate.identity_mismatch");
  }
  const observedAt = input.now();
  const observedAtMs = parseTimestamp(observedAt, "pull_request_gate.time_invalid");
  const observation = await observePullRequestGateMaterial(input.database, {
    materialHash: materialHash(snapshot),
    observedAt,
    workRef: input.workRef,
  });
  const materialSinceMs = parseTimestamp(
    observation.materialSince,
    "pull_request_gate.material_time_invalid",
  );
  const settleStartedAtMs = parseTimestamp(
    observation.settleStartedAt,
    "pull_request_gate.settle_time_invalid",
  );
  const decision = evaluatePullRequestGate(toDomainSnapshot(snapshot), {
    acceptedCheckConclusions: input.acceptedCheckConclusions,
    expectedBaseRef: input.target.baseRef,
    expectedBaseSha: input.target.baseSha,
    expectedHeadSha: input.target.headSha,
    quietPeriodSatisfied: observedAtMs - materialSinceMs >= input.quietPeriodMs,
    requiredChecks: input.requiredChecks,
  });
  let retryDueAt: string | null = null;
  if (decision.decision === "wait") {
    const settleDeadline = settleStartedAtMs + input.settleTimeoutMs;
    if (observedAtMs < settleDeadline) {
      retryDueAt = new Date(
        Math.min(observedAtMs + input.pollIntervalMs, settleDeadline),
      ).toISOString();
    }
  }
  await routePullRequestGateDecision(input.database, {
    decision,
    now: observedAt,
    retryDueAt,
    workRef: input.workRef,
  });
  return decision;
}

function toDomainSnapshot(snapshot: PullRequestSnapshot): PullRequestGateSnapshot {
  return {
    baseRef: snapshot.base_ref,
    checks: snapshot.checks.map((check) => ({
      conclusion: check.conclusion,
      name: check.name,
      ...(check.required_source === undefined ? {} : { requiredSource: check.required_source }),
      status: check.status,
      targetSha: check.target_sha,
    })),
    headSha: snapshot.head_sha,
    isDraft: snapshot.is_draft,
    mergeable: snapshot.mergeable,
    observedBaseSha: snapshot.observed_base_sha,
    prState: snapshot.pr_state,
    reviewDecision: snapshot.review_decision,
    unresolvedThreads: snapshot.unresolved_threads.map((thread) => ({
      commitSha: thread.commit_sha,
      id: thread.id,
      isOutdated: thread.is_outdated,
    })),
  };
}

function materialHash(snapshot: PullRequestSnapshot): string {
  const material = {
    base_ref: snapshot.base_ref,
    checks: snapshot.checks
      .map((check) => ({
        conclusion: check.conclusion,
        name: check.name,
        required_source: check.required_source ?? null,
        status: check.status,
        target_sha: check.target_sha,
      }))
      .sort((left, right) =>
        `${left.name}\0${left.target_sha}`.localeCompare(`${right.name}\0${right.target_sha}`),
      ),
    head_sha: snapshot.head_sha,
    mergeable: snapshot.mergeable,
    observed_base_sha: snapshot.observed_base_sha,
    review_decision: snapshot.review_decision,
    unresolved_threads: snapshot.unresolved_threads
      .filter((thread) => !thread.is_outdated)
      .map((thread) => ({ id: thread.id, commit_sha: thread.commit_sha }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

function toContractWorkRef(workRef: { id: string; kind: "issue" | "system_job" }): WorkRef {
  return workRef.kind === "issue" ? { issue_id: workRef.id } : { system_job_id: workRef.id };
}

function validateDurations(input: {
  pollIntervalMs: number;
  quietPeriodMs: number;
  settleTimeoutMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs <= 0 ||
    !Number.isSafeInteger(input.quietPeriodMs) ||
    input.quietPeriodMs < 0 ||
    !Number.isSafeInteger(input.settleTimeoutMs) ||
    input.settleTimeoutMs <= 0
  ) {
    throw new Error("pull_request_gate.duration_invalid");
  }
}

function parseTimestamp(value: string, reason: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(reason);
  return parsed;
}
