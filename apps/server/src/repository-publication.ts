import { createHash } from "node:crypto";

import type {
  ProviderMutationAuthority,
  RepositoryHostingAdapter,
  TrackerAdapter,
} from "@symphony/adapters";
import type {
  Issue,
  MutationAuthorization,
  SideEffectIntent,
  SideEffectReceipt,
} from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  commitRepositoryLinkAndReviewLane,
  createAuthorizedIntent,
  markIntentApplying,
  type OpenedDatabase,
  type PendingRepositoryPublication,
  recordSideEffectReceipt,
} from "@symphony/persistence";

interface AuthorizedMutation {
  authority: ProviderMutationAuthority & { authorization: MutationAuthorization };
  intent: SideEffectIntent;
}

export async function executeRepositoryPublication(input: {
  database: OpenedDatabase["database"];
  expiresAt: string;
  issue: Issue;
  newId(): string;
  now(): string;
  providerRevision: string;
  repository: RepositoryHostingAdapter;
  safety: PersistenceSafetyController;
  serviceRunId: string;
  target: PendingRepositoryPublication;
  tracker: TrackerAdapter;
}): Promise<void> {
  const repositoryName = `${input.issue.repo_owner}/${input.issue.repo_name}`;
  if (input.target.repository !== repositoryName) {
    throw new Error("publication.repository_mismatch");
  }
  const workRef = { issue_id: input.issue.id } as const;
  const repositoryTarget = `${repositoryName}:issue:${input.issue.id}`;

  const publish = composeAuthorizedMutation(input, {
    action: "repository.publish_branch",
    decisionRuleIds: ["publication.verified", "repository.base_revision_exact"],
    observedStateRef: `repository:${repositoryName}:base:${input.target.baseSha}`,
    payload: {
      expected_base_sha: input.target.baseSha,
      workspace: input.target.workspacePath,
    },
    target: repositoryTarget,
    targetRevision: input.target.baseSha,
  });
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: publish.authority.authorization,
      intent: publish.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, publish.intent.id, input.now()),
  );
  const published = await input.repository.publishBranch(
    workRef,
    input.target.workspacePath,
    input.target.baseSha,
    publish.authority,
  );
  if (
    published.headSha !== input.target.targetSha ||
    published.branch !== input.target.localBranch ||
    published.mutation.resultRevision !== input.target.targetSha
  ) {
    throw new Error("publication.published_branch_mismatch");
  }
  await durable(input.safety, () =>
    recordSideEffectReceipt(
      input.database,
      receipt(publish.intent.id, published.mutation, input.now()),
    ),
  );

  const bodyProjection = renderPullRequestBody(input.issue, input.target);
  const pullRequestMutation = composeAuthorizedMutation(input, {
    action: "repository.ensure_pull_request",
    decisionRuleIds: ["publication.verified", "repository.head_revision_exact"],
    observedStateRef: `repository:${repositoryName}:head:${published.headSha}`,
    payload: {
      base_ref: input.target.baseRef,
      body_projection_hash: sha256(bodyProjection),
      head_sha: published.headSha,
    },
    target: repositoryTarget,
    targetRevision: published.headSha,
  });
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: pullRequestMutation.authority.authorization,
      intent: pullRequestMutation.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, pullRequestMutation.intent.id, input.now()),
  );
  const pullRequest = await input.repository.ensurePullRequest(
    workRef,
    published.headSha,
    input.target.baseRef,
    bodyProjection,
    pullRequestMutation.authority,
  );
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number < 1 ||
    !pullRequest.url ||
    pullRequest.mutation.resultRevision === null
  ) {
    throw new Error("publication.pull_request_identity_invalid");
  }
  await durable(input.safety, () =>
    recordSideEffectReceipt(
      input.database,
      receipt(pullRequestMutation.intent.id, pullRequest.mutation, input.now()),
    ),
  );

  const lane = composeAuthorizedMutation(input, {
    action: "tracker.update_lane",
    decisionRuleIds: ["publication.verified", "lane.in_progress_to_review"],
    observedStateRef: `tracker:${input.issue.id}:${input.providerRevision}`,
    payload: { lane: "Review", reason: "publication.verified" },
    target: input.issue.id,
    targetRevision: input.providerRevision,
  });
  await durable(input.safety, () =>
    createAuthorizedIntent(input.database, {
      authorization: lane.authority.authorization,
      intent: lane.intent,
    }),
  );
  await durable(input.safety, () =>
    markIntentApplying(input.database, lane.intent.id, input.now()),
  );
  const laneResult = await input.tracker.updateIssueLane(
    input.issue.id,
    "Review",
    "publication.verified",
    lane.authority,
  );
  if (laneResult.resultRevision === null) throw new Error("publication.tracker_revision_missing");
  const appliedAt = input.now();
  await durable(input.safety, () =>
    commitRepositoryLinkAndReviewLane(input.database, {
      expectedReadyReason: "pull_request_required",
      link: {
        base_ref: input.target.baseRef,
        base_sha: input.target.baseSha,
        branch: published.branch,
        created_at: appliedAt,
        cycle: input.target.cycle,
        head_sha: published.headSha,
        id: requiredId(input.newId()),
        kind: "primary",
        pull_request_number: pullRequest.number,
        pull_request_url: pullRequest.url,
        repo_name: input.issue.repo_name,
        repo_owner: input.issue.repo_owner,
        state: "open",
        updated_at: appliedAt,
        work_ref: workRef,
      },
      nextReadyReason: "pull_request_hygiene_required",
      receipt: receipt(lane.intent.id, laneResult, appliedAt),
      transitionId: requiredId(input.newId()),
    }),
  );
}

function composeAuthorizedMutation(
  input: {
    expiresAt: string;
    issue: Pick<Issue, "id">;
    newId(): string;
    now(): string;
    serviceRunId: string;
    target: Pick<PendingRepositoryPublication, "attemptId" | "configSnapshotId">;
  },
  mutation: {
    action: string;
    decisionRuleIds: readonly string[];
    observedStateRef: string;
    payload: unknown;
    target: string;
    targetRevision: string;
  },
): AuthorizedMutation {
  const authorizedAt = input.now();
  if (!Number.isFinite(Date.parse(authorizedAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("publication.authorization_time_invalid");
  }
  const authorizationId = requiredId(input.newId());
  const intentId = requiredId(input.newId());
  const workRef = { issue_id: input.issue.id } as const;
  const authorization: MutationAuthorization = {
    action: mutation.action,
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: authorizedAt,
    config_snapshot_id: input.target.configSnapshotId,
    decision_rule_ids: [...mutation.decisionRuleIds],
    expires_at: input.expiresAt,
    id: authorizationId,
    idempotency_key: intentId,
    intent_id: intentId,
    observed_state_ref: mutation.observedStateRef,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target: mutation.target,
    target_revision: mutation.targetRevision,
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
        workRef: `issue:${input.issue.id}`,
      },
    },
    intent: {
      action: authorization.action,
      attempt_id: input.target.attemptId,
      authorization_id: authorization.id,
      created_at: authorizedAt,
      id: intentId,
      idempotency_key: intentId,
      request_payload_hash: sha256(JSON.stringify(mutation.payload)),
      scope: "work",
      service_run_id: input.serviceRunId,
      status: "pending",
      target: authorization.target,
      target_revision: authorization.target_revision,
      updated_at: authorizedAt,
      work_ref: workRef,
    },
  };
}

function renderPullRequestBody(issue: Issue, target: PendingRepositoryPublication): string {
  return [
    `Resolves ${issue.identifier}`,
    "",
    "## Symphony verification",
    "",
    `- Target revision: ${target.targetSha}`,
    `- Verification record: ${target.verificationRecordId}`,
  ].join("\n");
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

function requiredId(id: string): string {
  if (!id) throw new Error("publication.identity_invalid");
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
