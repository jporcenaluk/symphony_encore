import type { MutationAuthorization, PullRequestSnapshot, WorkRef } from "@symphony/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubRepositoryHostingAdapter,
  type GitHubRepositoryHostingTransport,
} from "./github-repository-hosting.js";
import type { ProviderMutationAuthority } from "./provider-authorization.js";

const workRef = { issue_id: "issue-1" } satisfies WorkRef;
const repository = "example/repo";
const operationTarget = `${repository}:issue:issue-1`;
const snapshot: PullRequestSnapshot = {
  base_ref: "main",
  checks: [],
  head_sha: "bbbbbbb",
  is_draft: false,
  mergeable: true,
  observed_base_sha: "aaaaaaa",
  post_merge_checks: [],
  pr_number: 1,
  pr_state: "open",
  pr_url: "https://github.com/example/repo/pull/1",
  required_check_source: "union",
  review_decision: "none",
  reviews: [],
  unresolved_threads: [],
};

function authority(action: string, revision: string, observedStateRef: string) {
  const authorization: MutationAuthorization = {
    action,
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: "2026-07-13T10:00:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["repository.mutation.allowed"],
    expires_at: "2026-07-13T10:05:00Z",
    id: `authorization:${action}`,
    idempotency_key: `intent:${action}`,
    intent_id: `intent:${action}`,
    observed_state_ref: observedStateRef,
    operator_capability: null,
    scope: "work",
    service_run_id: "run-1",
    target: operationTarget,
    target_revision: revision,
    work_ref: workRef,
  };
  return {
    authorization,
    expectation: {
      action,
      actorId: "orchestrator",
      actorKind: "orchestrator_policy" as const,
      attemptRole: "implementation",
      configSnapshotId: "config-1",
      idempotencyKey: `intent:${action}`,
      intentId: `intent:${action}`,
      observedStateRef,
      operatorCapability: null,
      scope: "work" as const,
      serviceRunId: "run-1",
      target: operationTarget,
      targetRevision: revision,
      workRef: "issue:issue-1",
    },
  } satisfies ProviderMutationAuthority;
}

function mutation(result: string) {
  return {
    providerRequestId: `request:${result}`,
    responsePayloadHash: `sha256:${result}`,
    result,
    resultRevision: "ccccccc",
  };
}

function transport(overrides: Partial<GitHubRepositoryHostingTransport> = {}) {
  return {
    createRepairPullRequest: vi.fn(async () => ({
      mutation: mutation("repair_pull_request"),
      number: 2,
      url: "https://github.com/example/repo/pull/2",
    })),
    ensurePullRequest: vi.fn(async () => ({
      mutation: mutation("pull_request"),
      number: 1,
      url: snapshot.pr_url,
    })),
    fetchBranchSha: vi.fn(async () => snapshot.head_sha),
    fetchCommitSha: vi.fn(async (sha) => sha),
    fetchDefaultBranchSha: vi.fn(async () => snapshot.observed_base_sha),
    fetchPostMergeStatus: vi.fn(async () => ({
      ...snapshot,
      head_sha: "ccccccc",
      pr_state: "merged" as const,
    })),
    fetchPullRequestSnapshot: vi.fn(async () => snapshot),
    mergePullRequest: vi.fn(async () => ({
      mergeSha: "ccccccc",
      mutation: mutation("merged"),
    })),
    publishBranch: vi.fn(async () => ({
      branch: "symphony/issue-1",
      headSha: snapshot.head_sha,
      mutation: mutation("published"),
    })),
    updateBranch: vi.fn(async () => ({
      branch: "symphony/issue-1",
      headSha: "ddddddd",
      mutation: mutation("updated"),
    })),
    ...overrides,
  } satisfies GitHubRepositoryHostingTransport;
}

describe("GitHub repository-hosting adapter", () => {
  it("executes every mutation only after exact revision and authority checks", async () => {
    const boundary = transport();
    const adapter = createGitHubRepositoryHostingAdapter(boundary, {
      now: () => Date.parse("2026-07-13T10:01:00Z"),
      repository,
    });

    await adapter.publishBranch(
      workRef,
      "/tmp/work/issue-1",
      "aaaaaaa",
      authority("repository.publish_branch", "aaaaaaa", `repository:${repository}:base:aaaaaaa`),
    );
    await adapter.ensurePullRequest(
      workRef,
      "bbbbbbb",
      "main",
      "body",
      authority(
        "repository.ensure_pull_request",
        "bbbbbbb",
        `repository:${repository}:head:bbbbbbb`,
      ),
    );
    const state = `repository:${repository}:head:bbbbbbb:base:aaaaaaa`;
    await adapter.updateBranch(
      workRef,
      "bbbbbbb",
      "aaaaaaa",
      authority("repository.update_branch", "bbbbbbb", state),
    );
    await adapter.mergePullRequest(
      workRef,
      "bbbbbbb",
      "squash",
      authority("repository.merge_pull_request", "bbbbbbb", state),
    );
    await adapter.createRepairPullRequest(
      workRef,
      "ccccccc",
      [{ kind: "commit", sha: "ccccccc" }],
      authority(
        "repository.create_repair_pull_request",
        "ccccccc",
        `repository:${repository}:failed_merge:ccccccc`,
      ),
    );

    expect(boundary.publishBranch).toHaveBeenCalledWith(
      workRef,
      "/tmp/work/issue-1",
      "aaaaaaa",
      "intent:repository.publish_branch",
    );
    expect(boundary.mergePullRequest).toHaveBeenCalledWith(
      workRef,
      "bbbbbbb",
      "squash",
      "intent:repository.merge_pull_request",
    );
  });

  it("rejects stale revisions before calling a mutation", async () => {
    const boundary = transport({ fetchDefaultBranchSha: vi.fn(async () => "fffffff") });
    const adapter = createGitHubRepositoryHostingAdapter(boundary, { repository });

    await expect(
      adapter.publishBranch(
        workRef,
        "/tmp/work/issue-1",
        "aaaaaaa",
        authority("repository.publish_branch", "aaaaaaa", `repository:${repository}:base:aaaaaaa`),
      ),
    ).rejects.toThrow("github.stale_base");
    expect(boundary.publishBranch).not.toHaveBeenCalled();
  });

  it("rejects malformed or partial snapshot data", async () => {
    const boundary = transport({
      fetchPullRequestSnapshot: vi.fn(async () => {
        const { unresolved_threads: _, ...partial } = snapshot;
        return partial;
      }),
    });
    const adapter = createGitHubRepositoryHostingAdapter(boundary, { repository });

    await expect(adapter.fetchPullRequestSnapshot(workRef)).rejects.toThrow(
      "repository.invalid_pull_request_snapshot",
    );
  });

  it("does not read post-merge state from a different repository", async () => {
    const boundary = transport();
    const adapter = createGitHubRepositoryHostingAdapter(boundary, { repository });

    await expect(adapter.fetchPostMergeStatus("other/repo", "ccccccc")).rejects.toThrow(
      "github.repository_mismatch",
    );
    expect(boundary.fetchPostMergeStatus).not.toHaveBeenCalled();
  });

  it("rejects a common authority-envelope mismatch", async () => {
    const boundary = transport();
    const adapter = createGitHubRepositoryHostingAdapter(boundary, {
      now: () => Date.parse("2026-07-13T10:01:00Z"),
      repository,
    });
    const candidate = authority(
      "repository.publish_branch",
      "aaaaaaa",
      `repository:${repository}:base:aaaaaaa`,
    );
    candidate.authorization = { ...candidate.authorization, config_snapshot_id: "stale-config" };

    await expect(
      adapter.publishBranch(workRef, "/tmp/work/issue-1", "aaaaaaa", candidate),
    ).rejects.toThrow("authorization.config_mismatch");
    expect(boundary.publishBranch).not.toHaveBeenCalled();
  });
});
