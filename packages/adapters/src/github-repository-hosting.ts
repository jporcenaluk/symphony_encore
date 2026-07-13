import type { EvidenceRef, PullRequestSnapshot, WorkRef } from "@symphony/contracts";
import { validatePullRequestSnapshot } from "@symphony/contracts";

import type {
  MergeResult,
  PublishedBranch,
  PullRequestIdentity,
  RepositoryHostingAdapter,
  RepositorySystemJobKind,
} from "./contracts.js";
import {
  assertProviderMutationAuthorization,
  formatWorkRef,
  ProviderAuthorizationError,
  type ProviderMutationAuthority,
} from "./provider-authorization.js";

export interface GitHubRepositoryHostingTransport {
  createRepairPullRequest(
    workRef: WorkRef,
    failedMergeSha: string,
    evidence: readonly EvidenceRef[],
    idempotencyKey: string,
  ): Promise<PullRequestIdentity>;
  ensurePullRequest(
    workRef: WorkRef,
    headSha: string,
    baseRef: string,
    bodyProjection: string,
    idempotencyKey: string,
    systemJobKind?: RepositorySystemJobKind,
    title?: string,
  ): Promise<PullRequestIdentity>;
  fetchBranchSha(workRef: WorkRef, systemJobKind?: RepositorySystemJobKind): Promise<string>;
  fetchCommitSha(sha: string): Promise<string>;
  fetchDefaultBranchSha(): Promise<string>;
  fetchPostMergeStatus(repository: string, mergeSha: string): Promise<unknown>;
  fetchPullRequestSnapshot(
    workRef: WorkRef,
    systemJobKind?: RepositorySystemJobKind,
  ): Promise<unknown>;
  mergePullRequest(
    workRef: WorkRef,
    expectedHeadSha: string,
    landingPolicy: string,
    idempotencyKey: string,
    systemJobKind?: RepositorySystemJobKind,
  ): Promise<MergeResult>;
  publishBranch(
    workRef: WorkRef,
    workspace: string,
    expectedBaseSha: string,
    idempotencyKey: string,
    systemJobKind?: RepositorySystemJobKind,
  ): Promise<PublishedBranch>;
  updateBranch(
    workRef: WorkRef,
    expectedHeadSha: string,
    expectedBaseSha: string,
    idempotencyKey: string,
    systemJobKind?: RepositorySystemJobKind,
  ): Promise<PublishedBranch>;
}

export function createGitHubRepositoryHostingAdapter(
  transport: GitHubRepositoryHostingTransport,
  options: { now?: () => number; repository: string },
): RepositoryHostingAdapter {
  const now = options.now ?? Date.now;
  return {
    async createRepairPullRequest(workRef, failedMergeSha, evidence, authority) {
      const observed = await transport.fetchCommitSha(failedMergeSha);
      if (observed !== failedMergeSha) throw new Error("github.stale_failed_merge");
      assertRepositoryAuthority(
        authority,
        "repository.create_repair_pull_request",
        target(options.repository, workRef),
        failedMergeSha,
        `repository:${options.repository}:failed_merge:${failedMergeSha}`,
        now(),
      );
      return transport.createRepairPullRequest(
        workRef,
        failedMergeSha,
        evidence,
        authority.expectation.idempotencyKey,
      );
    },

    async ensurePullRequest(
      workRef,
      headSha,
      baseRef,
      bodyProjection,
      authority,
      systemJobKind,
      title,
    ) {
      if ((await transport.fetchBranchSha(workRef, systemJobKind)) !== headSha)
        throw new Error("github.stale_head");
      assertRepositoryAuthority(
        authority,
        "repository.ensure_pull_request",
        target(options.repository, workRef),
        headSha,
        `repository:${options.repository}:head:${headSha}`,
        now(),
      );
      return transport.ensurePullRequest(
        workRef,
        headSha,
        baseRef,
        bodyProjection,
        authority.expectation.idempotencyKey,
        systemJobKind,
        title,
      );
    },

    async fetchPostMergeStatus(repository, mergeSha) {
      if (repository !== options.repository) throw new Error("github.repository_mismatch");
      return requireSnapshot(await transport.fetchPostMergeStatus(repository, mergeSha));
    },

    async fetchPullRequestSnapshot(workRef, systemJobKind) {
      return requireSnapshot(await transport.fetchPullRequestSnapshot(workRef, systemJobKind));
    },

    async mergePullRequest(workRef, expectedHeadSha, landingPolicy, authority, systemJobKind) {
      const snapshot = requireSnapshot(
        await transport.fetchPullRequestSnapshot(workRef, systemJobKind),
      );
      if (snapshot.head_sha !== expectedHeadSha) throw new Error("github.stale_head");
      assertRepositoryAuthority(
        authority,
        "repository.merge_pull_request",
        target(options.repository, workRef),
        expectedHeadSha,
        repositoryState(options.repository, expectedHeadSha, snapshot.observed_base_sha),
        now(),
      );
      return transport.mergePullRequest(
        workRef,
        expectedHeadSha,
        landingPolicy,
        authority.expectation.idempotencyKey,
        systemJobKind,
      );
    },

    async publishBranch(workRef, workspace, expectedBaseSha, authority, systemJobKind) {
      if ((await transport.fetchDefaultBranchSha()) !== expectedBaseSha) {
        throw new Error("github.stale_base");
      }
      assertRepositoryAuthority(
        authority,
        "repository.publish_branch",
        target(options.repository, workRef),
        expectedBaseSha,
        `repository:${options.repository}:base:${expectedBaseSha}`,
        now(),
      );
      return transport.publishBranch(
        workRef,
        workspace,
        expectedBaseSha,
        authority.expectation.idempotencyKey,
        systemJobKind,
      );
    },

    async updateBranch(workRef, expectedHeadSha, expectedBaseSha, authority, systemJobKind) {
      const snapshot = requireSnapshot(
        await transport.fetchPullRequestSnapshot(workRef, systemJobKind),
      );
      if (snapshot.head_sha !== expectedHeadSha) throw new Error("github.stale_head");
      if (snapshot.observed_base_sha !== expectedBaseSha) throw new Error("github.stale_base");
      assertRepositoryAuthority(
        authority,
        "repository.update_branch",
        target(options.repository, workRef),
        expectedHeadSha,
        repositoryState(options.repository, expectedHeadSha, expectedBaseSha),
        now(),
      );
      return transport.updateBranch(
        workRef,
        expectedHeadSha,
        expectedBaseSha,
        authority.expectation.idempotencyKey,
        systemJobKind,
      );
    },
  };
}

function requireSnapshot(value: unknown): PullRequestSnapshot {
  const validation = validatePullRequestSnapshot(value);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.snapshot;
}

function target(repository: string, workRef: WorkRef): string {
  return `${repository}:${formatWorkRef(workRef)}`;
}

function repositoryState(repository: string, headSha: string, baseSha: string): string {
  return `repository:${repository}:head:${headSha}:base:${baseSha}`;
}

function assertRepositoryAuthority(
  authority: ProviderMutationAuthority,
  action: string,
  operationTarget: string,
  revision: string,
  observedStateRef: string,
  now: number,
): void {
  if (authority.expectation.action !== action) {
    throw new ProviderAuthorizationError("authorization.action_mismatch");
  }
  if (authority.expectation.target !== operationTarget) {
    throw new ProviderAuthorizationError("authorization.target_mismatch");
  }
  if (authority.expectation.targetRevision !== revision) {
    throw new ProviderAuthorizationError("authorization.revision_mismatch");
  }
  if (authority.expectation.observedStateRef !== observedStateRef) {
    throw new ProviderAuthorizationError("authorization.observed_state_mismatch");
  }
  assertProviderMutationAuthorization(authority.authorization, authority.expectation, now);
}
