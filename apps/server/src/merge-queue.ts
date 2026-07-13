import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ProviderMutationAuthority,
  RepositoryHostingAdapter,
  TrackerAdapter,
} from "@symphony/adapters";
import type {
  Issue,
  MutationAuthorization,
  PullRequestSnapshot,
  SideEffectIntent,
  SideEffectReceipt,
  SystemJob,
  WorkRef,
} from "@symphony/contracts";
import { evaluatePullRequestGate, type PullRequestGateSnapshot } from "@symphony/domain";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  beginMergeQueueLanding,
  beginRepositoryBranchUpdate,
  commitMergeQueueLanding,
  commitPostMergeRepairCycle,
  commitPostMergeSuccess,
  commitPostMergeSystemJobRepairCycle,
  commitPostMergeSystemJobSuccess,
  commitRepairParentDoneLane,
  commitRepairParentReviewLane,
  commitRepositoryBranchUpdate,
  createAuthorizedIntent,
  loadAuthorizedMergeLogins,
  markIntentApplying,
  type OpenedDatabase,
  type PendingMergeQueue,
  type PendingPostMerge,
  routeMergeQueuePrecondition,
  routeMergeQueueRetry,
  routePostMergeRetry,
} from "@symphony/persistence";

export type MergeQueueResult =
  | { mergeSha: string; result: "merged" }
  | { reason: string; result: "precondition" | "waiting_for_approval" };

export async function executeMergeQueueLanding(input: {
  acceptedCheckConclusions: readonly string[];
  database: OpenedDatabase["database"];
  expiresAt: string;
  landingPolicy: "merge" | "rebase" | "squash";
  newId(): string;
  now(): string;
  pollIntervalMs: number;
  repository: RepositoryHostingAdapter;
  requiredChecks: readonly string[];
  safety: PersistenceSafetyController;
  serviceRunId: string;
  target: PendingMergeQueue;
  workRef: { id: string; kind: "issue" | "system_job" };
}): Promise<MergeQueueResult> {
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs <= 0) {
    throw new Error("merge_queue.poll_interval_invalid");
  }
  const contractWorkRef = toContractWorkRef(input.workRef);
  const snapshot = await input.repository.fetchPullRequestSnapshot(contractWorkRef);
  assertPullRequestIdentity(snapshot, input.target);
  const decision = evaluatePullRequestGate(toDomainSnapshot(snapshot), {
    acceptedCheckConclusions: input.acceptedCheckConclusions,
    expectedBaseRef: input.target.baseRef,
    expectedBaseSha: input.target.baseSha,
    expectedHeadSha: input.target.headSha,
    quietPeriodSatisfied: true,
    requiredChecks: input.requiredChecks,
  });
  if (decision.decision !== "allow") {
    const reason =
      decision.decision === "update_required"
        ? "base_update_required"
        : decision.decision === "deny"
          ? `pull_request_rework_required:${encodeURIComponent(decision.reason)}`
          : "pull_request_hygiene_required";
    await durable(input.safety, () =>
      routeMergeQueuePrecondition(input.database, {
        now: input.now(),
        reason,
        workRef: input.workRef,
      }),
    );
    return { reason, result: "precondition" };
  }

  const authorizedLogins = await loadAuthorizedMergeLogins(input.database);
  if (!hasAuthorizedMergeApproval(snapshot, authorizedLogins)) {
    const observedAt = input.now();
    await durable(input.safety, () =>
      routeMergeQueueRetry(input.database, {
        now: observedAt,
        retryDueAt: new Date(Date.parse(observedAt) + input.pollIntervalMs).toISOString(),
        workRef: input.workRef,
      }),
    );
    return { reason: "merge_queue.operator_approval_required", result: "waiting_for_approval" };
  }

  const landingAt = input.now();
  await durable(input.safety, () =>
    beginMergeQueueLanding(input.database, {
      baseSha: snapshot.observed_base_sha,
      headSha: snapshot.head_sha,
      now: landingAt,
      repository: input.target.repository,
      ...(input.workRef.kind === "system_job" ? { transitionId: requiredId(input.newId()) } : {}),
      workRef: input.workRef,
    }),
  );
  const mutation = composeMergeMutation(input, snapshot, landingAt);
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: mutation.authority.authorization,
      intent: mutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, mutation.intent.id, input.now()),
  );
  const merged = await input.repository.mergePullRequest(
    contractWorkRef,
    snapshot.head_sha,
    input.landingPolicy,
    mutation.authority,
  );
  if (!merged.mergeSha || merged.mutation.resultRevision !== merged.mergeSha) {
    throw new Error("merge_queue.merge_response_invalid");
  }
  const appliedAt = input.now();
  await durable(input.safety, () =>
    commitMergeQueueLanding(input.database, {
      mergeSha: merged.mergeSha,
      now: appliedAt,
      receipt: receipt(mutation.intent.id, merged.mutation, appliedAt),
      retryDueAt: new Date(Date.parse(appliedAt) + input.pollIntervalMs).toISOString(),
      workRef: input.workRef,
    }),
  );
  return { mergeSha: merged.mergeSha, result: "merged" };
}

export async function executePostMergeVerification(input: {
  acceptedCheckConclusions: readonly string[];
  database: OpenedDatabase["database"];
  expiresAt: string;
  issue: Pick<Issue, "acceptance_criteria" | "id" | "title">;
  newId(): string;
  now(): string;
  pollIntervalMs: number;
  repository: RepositoryHostingAdapter;
  requiredChecks: readonly string[];
  safety: PersistenceSafetyController;
  serviceRunId: string;
  settleTimeoutMs: number;
  target: PendingPostMerge;
  tracker: TrackerAdapter;
  workRef: { id: string; kind: "issue" };
  workspaceRoot: string;
}): Promise<{ reason?: string; result: "completed" | "failed" | "waiting" }> {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs <= 0 ||
    !Number.isSafeInteger(input.settleTimeoutMs) ||
    input.settleTimeoutMs <= 0
  ) {
    throw new Error("merge_queue.post_merge_duration_invalid");
  }
  const snapshot = await input.repository.fetchPostMergeStatus(
    input.target.repository,
    input.target.mergeSha,
  );
  if (snapshot.head_sha !== input.target.mergeSha || snapshot.pr_state !== "merged") {
    throw new Error("merge_queue.post_merge_identity_mismatch");
  }
  const decision = evaluatePostMergeChecks(
    snapshot.post_merge_checks,
    input.target.mergeSha,
    input.requiredChecks,
    input.acceptedCheckConclusions,
  );
  const observedAt = input.now();
  if (decision.decision === "wait") {
    if (Date.parse(observedAt) - Date.parse(input.target.startedAt) >= input.settleTimeoutMs) {
      await createRepairCycle(input, `post_merge.timeout:${decision.reason}`, observedAt);
      return { reason: decision.reason, result: "failed" };
    }
    await durable(input.safety, () =>
      routePostMergeRetry(input.database, {
        now: observedAt,
        retryDueAt: new Date(Date.parse(observedAt) + input.pollIntervalMs).toISOString(),
        workRef: input.workRef,
      }),
    );
    return { reason: decision.reason, result: "waiting" };
  }
  if (decision.decision === "fail") {
    await createRepairCycle(input, decision.reason, observedAt);
    return { reason: decision.reason, result: "failed" };
  }

  const mutation = composeDoneMutation(input, observedAt);
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: mutation.authority.authorization,
      intent: mutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, mutation.intent.id, input.now()),
  );
  const lane = await input.tracker.updateIssueLane(
    input.workRef.id,
    "Done",
    "merge_queue.post_merge_checks_passed",
    mutation.authority,
  );
  if (lane.resultRevision === null) throw new Error("merge_queue.tracker_revision_missing");
  const appliedAt = input.now();
  await durable(input.safety, () =>
    commitPostMergeSuccess(input.database, {
      now: appliedAt,
      receipt: receipt(mutation.intent.id, lane, appliedAt),
      transitionId: requiredId(input.newId()),
      workRef: input.workRef,
    }),
  );
  return { result: "completed" };
}

export async function executeSystemJobPostMergeVerification(input: {
  acceptedCheckConclusions: readonly string[];
  database: OpenedDatabase["database"];
  job: Pick<SystemJob, "acceptance_criteria" | "goal" | "id">;
  newId(): string;
  now(): string;
  pollIntervalMs: number;
  repository: RepositoryHostingAdapter;
  requiredChecks: readonly string[];
  safety: PersistenceSafetyController;
  settleTimeoutMs: number;
  target: PendingPostMerge;
  workRef: { id: string; kind: "system_job" };
  workspaceRoot: string;
}): Promise<{ reason?: string; result: "completed" | "failed" | "waiting" }> {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs <= 0 ||
    !Number.isSafeInteger(input.settleTimeoutMs) ||
    input.settleTimeoutMs <= 0
  ) {
    throw new Error("merge_queue.post_merge_duration_invalid");
  }
  const snapshot = await input.repository.fetchPostMergeStatus(
    input.target.repository,
    input.target.mergeSha,
  );
  if (snapshot.head_sha !== input.target.mergeSha || snapshot.pr_state !== "merged") {
    throw new Error("merge_queue.post_merge_identity_mismatch");
  }
  const decision = evaluatePostMergeChecks(
    snapshot.post_merge_checks,
    input.target.mergeSha,
    input.requiredChecks,
    input.acceptedCheckConclusions,
  );
  const observedAt = input.now();
  if (decision.decision === "wait") {
    if (Date.parse(observedAt) - Date.parse(input.target.startedAt) >= input.settleTimeoutMs) {
      await createSystemJobRepairCycle(input, `post_merge.timeout:${decision.reason}`, observedAt);
      return { reason: decision.reason, result: "failed" };
    }
    await durable(input.safety, () =>
      routePostMergeRetry(input.database, {
        now: observedAt,
        retryDueAt: new Date(Date.parse(observedAt) + input.pollIntervalMs).toISOString(),
        workRef: input.workRef,
      }),
    );
    return { reason: decision.reason, result: "waiting" };
  }
  if (decision.decision === "fail") {
    await createSystemJobRepairCycle(input, decision.reason, observedAt);
    return { reason: decision.reason, result: "failed" };
  }
  await durable(input.safety, () =>
    commitPostMergeSystemJobSuccess(input.database, {
      now: observedAt,
      transitionId: requiredId(input.newId()),
      workRef: input.workRef,
    }),
  );
  return { result: "completed" };
}

async function createSystemJobRepairCycle(
  input: {
    database: OpenedDatabase["database"];
    job: Pick<SystemJob, "acceptance_criteria" | "goal" | "id">;
    newId(): string;
    safety: PersistenceSafetyController;
    target: PendingPostMerge;
    workRef: { id: string; kind: "system_job" };
    workspaceRoot: string;
  },
  reason: string,
  observedAt: string,
): Promise<void> {
  const repairJobId = requiredId(input.newId());
  await durable(input.safety, () =>
    commitPostMergeSystemJobRepairCycle(input.database, {
      acceptanceCriteria: [
        `Restore passing post-merge checks for ${input.target.mergeSha}`,
        ...input.job.acceptance_criteria,
      ],
      configSnapshotId: input.target.configSnapshotId,
      goal: `Repair ${input.job.goal}: ${reason}`,
      now: observedAt,
      repairJobId,
      repository: input.target.repository,
      transitionId: requiredId(input.newId()),
      workRef: input.workRef,
      workspacePath: path.join(
        input.workspaceRoot,
        "_system",
        `repair-${repairJobId.replace(/[^A-Za-z0-9._-]+/gu, "_")}`,
      ),
    }),
  );
}

export async function executeRepairParentCompletion(input: {
  configSnapshotId: string;
  database: OpenedDatabase["database"];
  expiresAt: string;
  issueId: string;
  lane: "Done" | "Review";
  newId(): string;
  now(): string;
  providerRevision: string;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  tracker: TrackerAdapter;
}): Promise<void> {
  const authorizedAt = input.now();
  const mutation = composeRepairParentCompletionMutation(input, authorizedAt);
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: mutation.authority.authorization,
      intent: mutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, mutation.intent.id, input.now()),
  );
  const lane = await input.tracker.updateIssueLane(
    input.issueId,
    input.lane,
    "merge_queue.repair_completed",
    mutation.authority,
  );
  if (lane.resultRevision === null) throw new Error("merge_queue.tracker_revision_missing");
  const appliedAt = input.now();
  const commit =
    input.lane === "Review" ? commitRepairParentReviewLane : commitRepairParentDoneLane;
  await durable(input.safety, () =>
    commit(input.database, {
      now: appliedAt,
      receipt: receipt(mutation.intent.id, lane, appliedAt),
      transitionId: requiredId(input.newId()),
      workRef: { id: input.issueId, kind: "issue" },
    }),
  );
}

async function createRepairCycle(
  input: {
    database: OpenedDatabase["database"];
    expiresAt: string;
    issue: Pick<Issue, "acceptance_criteria" | "id" | "title">;
    newId(): string;
    now(): string;
    safety: PersistenceSafetyController;
    serviceRunId: string;
    target: PendingPostMerge;
    tracker: TrackerAdapter;
    workRef: { id: string; kind: "issue" };
    workspaceRoot: string;
  },
  reason: string,
  authorizedAt: string,
): Promise<void> {
  const mutation = composeRepairLaneMutation(input, reason, authorizedAt);
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: mutation.authority.authorization,
      intent: mutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, mutation.intent.id, input.now()),
  );
  const lane = await input.tracker.updateIssueLane(
    input.workRef.id,
    "In Progress",
    "merge_queue.post_merge_failed",
    mutation.authority,
  );
  if (lane.resultRevision === null) throw new Error("merge_queue.tracker_revision_missing");
  const repairJobId = requiredId(input.newId());
  const appliedAt = input.now();
  await durable(input.safety, () =>
    commitPostMergeRepairCycle(input.database, {
      acceptanceCriteria: [
        `Restore passing post-merge checks for ${input.target.mergeSha}`,
        ...input.issue.acceptance_criteria,
      ],
      configSnapshotId: input.target.configSnapshotId,
      goal: `Repair ${input.issue.title}: ${reason}`,
      now: appliedAt,
      receipt: receipt(mutation.intent.id, lane, appliedAt),
      repairJobId,
      repository: input.target.repository,
      transitionId: requiredId(input.newId()),
      workRef: input.workRef,
      workspacePath: path.join(
        input.workspaceRoot,
        "_system",
        `repair-${repairJobId.replace(/[^A-Za-z0-9._-]+/gu, "_")}`,
      ),
    }),
  );
}

export async function executeBaseUpdate(input: {
  database: OpenedDatabase["database"];
  expiresAt: string;
  newId(): string;
  now(): string;
  repository: RepositoryHostingAdapter;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  syncWorkspace(request: {
    branch: string;
    expectedHeadSha: string;
    workspace: string;
  }): Promise<string>;
  target: PendingMergeQueue;
  workRef: { id: string; kind: "issue" };
}): Promise<{ baseSha: string; headSha: string }> {
  const contractWorkRef = { issue_id: input.workRef.id } as const;
  const snapshot = await input.repository.fetchPullRequestSnapshot(contractWorkRef);
  assertPullRequestIdentity(snapshot, input.target);
  if (snapshot.observed_base_sha === input.target.baseSha) {
    throw new Error("merge_queue.base_not_advanced");
  }
  const startedAt = input.now();
  await durable(input.safety, () =>
    beginRepositoryBranchUpdate(input.database, {
      baseSha: snapshot.observed_base_sha,
      headSha: snapshot.head_sha,
      now: startedAt,
      repository: input.target.repository,
      workRef: input.workRef,
    }),
  );
  const mutation = composeBranchUpdateMutation(input, snapshot, startedAt);
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: mutation.authority.authorization,
      intent: mutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, mutation.intent.id, input.now()),
  );
  const updated = await input.repository.updateBranch(
    contractWorkRef,
    snapshot.head_sha,
    snapshot.observed_base_sha,
    mutation.authority,
  );
  if (
    updated.branch !== input.target.branch ||
    updated.headSha === snapshot.head_sha ||
    updated.mutation.resultRevision !== updated.headSha
  ) {
    throw new Error("merge_queue.branch_update_response_invalid");
  }
  const synchronized = await input.syncWorkspace({
    branch: updated.branch,
    expectedHeadSha: updated.headSha,
    workspace: input.target.workspacePath,
  });
  if (synchronized !== updated.headSha) throw new Error("merge_queue.workspace_sync_mismatch");
  const appliedAt = input.now();
  await durable(input.safety, () =>
    commitRepositoryBranchUpdate(input.database, {
      baseSha: snapshot.observed_base_sha,
      headSha: updated.headSha,
      now: appliedAt,
      receipt: receipt(mutation.intent.id, updated.mutation, appliedAt),
      workRef: input.workRef,
    }),
  );
  return { baseSha: snapshot.observed_base_sha, headSha: updated.headSha };
}

export function hasAuthorizedMergeApproval(
  snapshot: PullRequestSnapshot,
  authorizedLogins: readonly string[],
): boolean {
  const authorized = new Set(authorizedLogins.map((login) => login.toLocaleLowerCase("en-US")));
  const latest = new Map<string, (typeof snapshot.reviews)[number]>();
  for (const review of snapshot.reviews) {
    const author = review.author.toLocaleLowerCase("en-US");
    if (!authorized.has(author) || review.commit_sha !== snapshot.head_sha) continue;
    const previous = latest.get(author);
    if (!previous || Date.parse(review.submitted_at) > Date.parse(previous.submitted_at)) {
      latest.set(author, review);
    }
  }
  return [...latest.values()].some(
    (review) => review.state.toLocaleLowerCase("en-US") === "approved",
  );
}

export function evaluatePostMergeChecks(
  checks: PullRequestSnapshot["post_merge_checks"],
  mergeSha: string,
  requiredChecks: readonly string[],
  acceptedConclusions: readonly string[],
): { decision: "allow" } | { decision: "fail" | "wait"; reason: string } {
  const accepted = new Set(
    acceptedConclusions.map((conclusion) => conclusion.toLocaleLowerCase("en-US")),
  );
  const names =
    requiredChecks.length > 0
      ? [...new Set(requiredChecks)]
      : [...new Set(checks.map((check) => check.name))].sort();
  for (const name of names) {
    const matching = checks.filter((check) => check.name === name && check.target_sha === mergeSha);
    if (matching.length !== 1) {
      return {
        decision: "wait",
        reason:
          matching.length === 0
            ? `post_merge.check_missing:${name}`
            : `post_merge.check_ambiguous:${name}`,
      };
    }
    const check = matching[0];
    if (check?.status.toLocaleLowerCase("en-US") !== "completed") {
      return { decision: "wait", reason: `post_merge.check_pending:${name}` };
    }
    const conclusion = check.conclusion?.toLocaleLowerCase("en-US") ?? null;
    if (conclusion === null) {
      return { decision: "wait", reason: `post_merge.check_pending:${name}` };
    }
    if (!accepted.has(conclusion)) {
      return { decision: "fail", reason: `post_merge.check_failed:${name}:${conclusion}` };
    }
  }
  return { decision: "allow" };
}

function assertPullRequestIdentity(snapshot: PullRequestSnapshot, target: PendingMergeQueue): void {
  if (
    snapshot.pr_number !== target.pullRequestNumber ||
    snapshot.pr_url !== target.pullRequestUrl ||
    snapshot.head_sha !== target.headSha ||
    snapshot.base_ref !== target.baseRef
  ) {
    throw new Error("merge_queue.pull_request_identity_mismatch");
  }
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

function composeMergeMutation(
  input: {
    expiresAt: string;
    landingPolicy: string;
    newId(): string;
    serviceRunId: string;
    target: PendingMergeQueue;
    workRef: { id: string; kind: "issue" } | { id: string; kind: "issue" | "system_job" };
  },
  snapshot: PullRequestSnapshot,
  authorizedAt: string,
): {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
} {
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("merge_queue.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = toContractWorkRef(input.workRef);
  const workRefIdentity = contractWorkRefIdentity(workRef);
  const target = `${input.target.repository}:${workRefIdentity}`;
  const observedStateRef = `repository:${input.target.repository}:head:${snapshot.head_sha}:base:${snapshot.observed_base_sha}`;
  const authorization: MutationAuthorization = {
    action: "repository.merge_pull_request",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.target.configSnapshotId,
    decision_rule_ids: [
      "merge_queue.review_set_approved",
      "merge_queue.current_head_gate_allowed",
      "merge_queue.operator_approved",
    ],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: observedStateRef,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target,
    target_revision: snapshot.head_sha,
    work_ref: workRef,
  };
  return {
    authority: {
      authorization,
      expectation: {
        action: authorization.action,
        actorId: authorization.actor_id,
        actorKind: authorization.actor_kind,
        attemptRole: authorization.attempt_role,
        configSnapshotId: authorization.config_snapshot_id,
        idempotencyKey: authorization.idempotency_key,
        intentId: authorization.intent_id,
        observedStateRef: authorization.observed_state_ref,
        operatorCapability: authorization.operator_capability,
        scope: authorization.scope,
        serviceRunId: authorization.service_run_id,
        target: authorization.target,
        targetRevision: authorization.target_revision,
        workRef: workRefIdentity,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: input.target.attemptId,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(
        JSON.stringify({
          expected_head_sha: snapshot.head_sha,
          landing_policy: input.landingPolicy,
          review_set_id: input.target.reviewSetId,
        }),
      ),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target,
      target_revision: snapshot.head_sha,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function composeDoneMutation(
  input: {
    expiresAt: string;
    newId(): string;
    serviceRunId: string;
    target: PendingPostMerge;
    workRef: { id: string; kind: "issue" };
  },
  authorizedAt: string,
): {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
} {
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("merge_queue.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = { issue_id: input.workRef.id } as const;
  const authorization: MutationAuthorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.target.configSnapshotId,
    decision_rule_ids: ["merge_queue.post_merge_checks_passed"],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: `tracker:${input.workRef.id}:${input.target.providerRevision}`,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target: input.workRef.id,
    target_revision: input.target.providerRevision,
    work_ref: workRef,
  };
  return {
    authority: {
      authorization,
      expectation: {
        action: authorization.action,
        actorId: authorization.actor_id,
        actorKind: authorization.actor_kind,
        attemptRole: authorization.attempt_role,
        configSnapshotId: authorization.config_snapshot_id,
        idempotencyKey: authorization.idempotency_key,
        intentId: authorization.intent_id,
        observedStateRef: authorization.observed_state_ref,
        operatorCapability: authorization.operator_capability,
        scope: authorization.scope,
        serviceRunId: authorization.service_run_id,
        target: authorization.target,
        targetRevision: authorization.target_revision,
        workRef: `issue:${input.workRef.id}`,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: input.target.attemptId,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(
        JSON.stringify({ lane: "Done", merge_sha: input.target.mergeSha }),
      ),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target: input.workRef.id,
      target_revision: input.target.providerRevision,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function composeRepairParentCompletionMutation(
  input: {
    configSnapshotId: string;
    expiresAt: string;
    issueId: string;
    lane: "Done" | "Review";
    newId(): string;
    providerRevision: string;
    serviceRunId: string;
  },
  authorizedAt: string,
): {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
} {
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("merge_queue.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = { issue_id: input.issueId } as const;
  const authorization: MutationAuthorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.configSnapshotId,
    decision_rule_ids: ["merge_queue.repair_completed"],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: `tracker:${input.issueId}:${input.providerRevision}`,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target: input.issueId,
    target_revision: input.providerRevision,
    work_ref: workRef,
  };
  return {
    authority: {
      authorization,
      expectation: {
        action: authorization.action,
        actorId: authorization.actor_id,
        actorKind: authorization.actor_kind,
        attemptRole: authorization.attempt_role,
        configSnapshotId: authorization.config_snapshot_id,
        idempotencyKey: authorization.idempotency_key,
        intentId: authorization.intent_id,
        observedStateRef: authorization.observed_state_ref,
        operatorCapability: authorization.operator_capability,
        scope: authorization.scope,
        serviceRunId: authorization.service_run_id,
        target: authorization.target,
        targetRevision: authorization.target_revision,
        workRef: `issue:${input.issueId}`,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: null,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(JSON.stringify({ lane: input.lane })),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target: input.issueId,
      target_revision: input.providerRevision,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function composeBranchUpdateMutation(
  input: {
    expiresAt: string;
    newId(): string;
    serviceRunId: string;
    target: PendingMergeQueue;
    workRef: { id: string; kind: "issue" };
  },
  snapshot: PullRequestSnapshot,
  authorizedAt: string,
): {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
} {
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("merge_queue.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = { issue_id: input.workRef.id } as const;
  const target = `${input.target.repository}:issue:${input.workRef.id}`;
  const observedStateRef = `repository:${input.target.repository}:head:${snapshot.head_sha}:base:${snapshot.observed_base_sha}`;
  const authorization: MutationAuthorization = {
    action: "repository.update_branch",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.target.configSnapshotId,
    decision_rule_ids: ["merge_queue.base_advanced", "repository.head_revision_exact"],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: observedStateRef,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target,
    target_revision: snapshot.head_sha,
    work_ref: workRef,
  };
  return {
    authority: {
      authorization,
      expectation: {
        action: authorization.action,
        actorId: authorization.actor_id,
        actorKind: authorization.actor_kind,
        attemptRole: authorization.attempt_role,
        configSnapshotId: authorization.config_snapshot_id,
        idempotencyKey: authorization.idempotency_key,
        intentId: authorization.intent_id,
        observedStateRef: authorization.observed_state_ref,
        operatorCapability: authorization.operator_capability,
        scope: authorization.scope,
        serviceRunId: authorization.service_run_id,
        target: authorization.target,
        targetRevision: authorization.target_revision,
        workRef: `issue:${input.workRef.id}`,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: input.target.attemptId,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(
        JSON.stringify({
          expected_base_sha: snapshot.observed_base_sha,
          expected_head_sha: snapshot.head_sha,
        }),
      ),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target,
      target_revision: snapshot.head_sha,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function composeRepairLaneMutation(
  input: {
    expiresAt: string;
    newId(): string;
    serviceRunId: string;
    target: PendingPostMerge;
    workRef: { id: string; kind: "issue" };
  },
  reason: string,
  authorizedAt: string,
): {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
} {
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("merge_queue.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = { issue_id: input.workRef.id } as const;
  const authorization: MutationAuthorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.target.configSnapshotId,
    decision_rule_ids: ["merge_queue.post_merge_failed", reason],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: `tracker:${input.workRef.id}:${input.target.providerRevision}`,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target: input.workRef.id,
    target_revision: input.target.providerRevision,
    work_ref: workRef,
  };
  return {
    authority: {
      authorization,
      expectation: {
        action: authorization.action,
        actorId: authorization.actor_id,
        actorKind: authorization.actor_kind,
        attemptRole: authorization.attempt_role,
        configSnapshotId: authorization.config_snapshot_id,
        idempotencyKey: authorization.idempotency_key,
        intentId: authorization.intent_id,
        observedStateRef: authorization.observed_state_ref,
        operatorCapability: authorization.operator_capability,
        scope: authorization.scope,
        serviceRunId: authorization.service_run_id,
        target: authorization.target,
        targetRevision: authorization.target_revision,
        workRef: `issue:${input.workRef.id}`,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: input.target.attemptId,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(
        JSON.stringify({ lane: "In Progress", merge_sha: input.target.mergeSha, reason }),
      ),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target: input.workRef.id,
      target_revision: input.target.providerRevision,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function receipt(
  intentId: string,
  mutation: {
    providerRequestId: string;
    responsePayloadHash: string;
    result: string;
    resultRevision: string | null;
  },
  appliedAt: string,
): SideEffectReceipt {
  return {
    applied_at: appliedAt,
    intent_id: intentId,
    provider_request_id: mutation.providerRequestId,
    response_payload_hash: mutation.responsePayloadHash,
    result: mutation.result,
    result_revision: mutation.resultRevision,
  };
}

function toContractWorkRef(workRef: { id: string; kind: "issue" | "system_job" }): WorkRef {
  return workRef.kind === "issue" ? { issue_id: workRef.id } : { system_job_id: workRef.id };
}

function contractWorkRefIdentity(workRef: WorkRef): string {
  return "issue_id" in workRef
    ? `issue:${workRef.issue_id}`
    : `system_job:${workRef.system_job_id}`;
}

function requiredId(id: string): string {
  if (!id) throw new Error("merge_queue.identity_invalid");
  return id;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function durable<T>(
  safety: PersistenceSafetyController,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await safety.recordFailure(failure);
    throw failure;
  }
}
