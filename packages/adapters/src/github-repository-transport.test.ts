import { describe, expect, it, vi } from "vitest";

import type { GhCliApiClient, GhRestResponse } from "./gh-cli-api.js";
import {
  createGitHubRepositoryTransport,
  githubBranchForWorkRef,
} from "./github-repository-transport.js";
import type { WorkspaceCommandRunner } from "./github-workspace.js";

const workRef = { issue_id: "issue-node-1" } as const;

describe("GitHub repository transport", () => {
  it("publishes the exact local head with a remote lease and confirms the provider revision", async () => {
    const branch = githubBranchForWorkRef(workRef);
    const run = vi.fn<WorkspaceCommandRunner["run"]>(async (request) => {
      if (request.arguments.includes("rev-parse")) {
        return { exitCode: 0, stderr: "", stdout: "def5678\n" };
      }
      if (request.arguments.includes("ls-remote")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "pushed" };
    });
    const rest = vi.fn(async () =>
      response(
        { object: { sha: "def5678", type: "commit" }, ref: `refs/heads/${branch}` },
        "REQ-REF",
      ),
    );
    const transport = createGitHubRepositoryTransport({
      api: api(rest),
      commandRunner: { run },
      environment: { GH_TOKEN: "trusted", PATH: "/usr/bin" },
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(
      transport.publishBranch(workRef, "/work/issue-1", "abc1234", "intent-publish"),
    ).resolves.toMatchObject({
      branch,
      headSha: "def5678",
      mutation: {
        providerRequestId: "REQ-REF",
        result: "published",
        resultRevision: "def5678",
      },
    });
    expect(run).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        arguments: [
          "-C",
          "/work/issue-1",
          "push",
          "origin",
          `HEAD:refs/heads/${branch}`,
          `--force-with-lease=refs/heads/${branch}:`,
        ],
        command: "git",
      }),
    );
    expect(rest).toHaveBeenCalledWith({
      method: "GET",
      path: `repos/owner/repo/git/ref/heads/${encodeURIComponent(branch)}`,
    });
  });

  it("creates or updates the deterministic branch pull request", async () => {
    const branch = githubBranchForWorkRef(workRef);
    const rest = vi
      .fn()
      .mockResolvedValueOnce(response([], "REQ-LIST"))
      .mockResolvedValueOnce(
        response(
          {
            base: { ref: "main" },
            head: { ref: branch, sha: "def5678" },
            html_url: "https://github.com/owner/repo/pull/42",
            number: 42,
          },
          "REQ-CREATE",
        ),
      );
    const transport = createGitHubRepositoryTransport({
      api: api(rest),
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(
      transport.ensurePullRequest(workRef, "def5678", "main", "Verified body", "intent-pr"),
    ).resolves.toMatchObject({
      mutation: {
        providerRequestId: "REQ-CREATE",
        result: "created",
        resultRevision: "def5678",
      },
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    expect(rest).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: `repos/owner/repo/pulls?state=open&head=${encodeURIComponent(`owner:${branch}`)}&per_page=100`,
    });
    expect(rest).toHaveBeenNthCalledWith(2, {
      body: {
        base: "main",
        body: "Verified body",
        head: branch,
        title: "Symphony issue issue-node-1",
      },
      method: "POST",
      path: "repos/owner/repo/pulls",
    });
  });

  it("creates a linked repair pull request from the published repair SystemJob branch", async () => {
    const repairRef = { system_job_id: "repair-job-1" } as const;
    const branch = githubBranchForWorkRef(repairRef);
    expect(branch).toMatch(/^symphony\/system-repair-[a-f0-9]{16}$/u);
    const rest = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { object: { sha: "def5678", type: "commit" }, ref: `refs/heads/${branch}` },
          "REQ-REF",
        ),
      )
      .mockResolvedValueOnce(response({ default_branch: "main" }, "REQ-REPO"))
      .mockResolvedValueOnce(response([], "REQ-LIST"))
      .mockResolvedValueOnce(
        response(
          {
            base: { ref: "main" },
            head: { ref: branch, sha: "def5678" },
            html_url: "https://github.com/owner/repo/pull/43",
            number: 43,
          },
          "REQ-REPAIR",
        ),
      );
    const transport = createGitHubRepositoryTransport({
      api: api(rest),
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(
      transport.createRepairPullRequest(
        repairRef,
        "fedcba9",
        [
          {
            conclusion: "failed",
            kind: "check",
            name: "deploy / staging",
            url: "https://ci.example.test/2",
          },
        ],
        "intent-repair",
      ),
    ).resolves.toMatchObject({
      mutation: { result: "created", resultRevision: "def5678" },
      number: 43,
    });
    expect(rest).toHaveBeenNthCalledWith(4, {
      body: {
        base: "main",
        body: expect.stringContaining("Failed merge: fedcba9"),
        head: branch,
        title: "Symphony repair repair-job-1",
      },
      method: "POST",
      path: "repos/owner/repo/pulls",
    });
  });

  it("updates an exact pull request head against the observed base revision", async () => {
    const branch = githubBranchForWorkRef(workRef);
    const graphql = vi.fn().mockResolvedValue({
      data: basicPullRequest(branch, "def5678", "abc1234"),
      requestId: "REQ-BASIC",
    });
    const rest = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            message: "Updating pull request branch.",
            url: "https://github.com/owner/repo/pull/42",
          },
          "REQ-UPDATE",
        ),
      )
      .mockResolvedValueOnce(
        response(
          { object: { sha: "fedcba9", type: "commit" }, ref: `refs/heads/${branch}` },
          "REQ-REF",
        ),
      );
    const transport = createGitHubRepositoryTransport({
      api: { graphql: graphql as GhCliApiClient["graphql"], rest },
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(
      transport.updateBranch(workRef, "def5678", "abc1234", "intent-update"),
    ).resolves.toMatchObject({
      branch,
      headSha: "fedcba9",
      mutation: {
        providerRequestId: "REQ-UPDATE",
        result: "updated",
        resultRevision: "fedcba9",
      },
    });
    expect(rest).toHaveBeenNthCalledWith(1, {
      body: { expected_head_sha: "def5678" },
      method: "PUT",
      path: "repos/owner/repo/pulls/42/update-branch",
    });
  });

  it("merges only the exact pull request head with an allowlisted landing method", async () => {
    const branch = githubBranchForWorkRef(workRef);
    const graphql = vi.fn().mockResolvedValue({
      data: basicPullRequest(branch, "def5678", "abc1234"),
      requestId: "REQ-BASIC",
    });
    const rest = vi
      .fn()
      .mockResolvedValue(
        response(
          { merged: true, message: "Pull Request successfully merged", sha: "fedcba9" },
          "REQ-MERGE",
        ),
      );
    const transport = createGitHubRepositoryTransport({
      api: { graphql: graphql as GhCliApiClient["graphql"], rest },
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(
      transport.mergePullRequest(workRef, "def5678", "squash", "intent-merge"),
    ).resolves.toMatchObject({
      mergeSha: "fedcba9",
      mutation: {
        providerRequestId: "REQ-MERGE",
        result: "merged",
        resultRevision: "fedcba9",
      },
    });
    expect(rest).toHaveBeenCalledWith({
      body: { merge_method: "squash", sha: "def5678" },
      method: "PUT",
      path: "repos/owner/repo/pulls/42/merge",
    });
    await expect(
      transport.mergePullRequest(workRef, "def5678", "octopus", "intent-invalid"),
    ).rejects.toThrow("github.landing_policy_invalid");
  });

  it("normalizes complete post-merge checks for the exact merge revision", async () => {
    const graphql = vi.fn().mockResolvedValue({
      data: {
        repository: {
          object: {
            associatedPullRequests: {
              nodes: [
                {
                  baseRefName: "main",
                  isDraft: false,
                  number: 42,
                  state: "MERGED",
                  url: "https://github.com/owner/repo/pull/42",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
            oid: "fedcba9",
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    checkSuite: { commit: { oid: "fedcba9" } },
                    conclusion: "SUCCESS",
                    detailsUrl: "https://github.com/owner/repo/actions/runs/2",
                    name: "deploy / staging",
                    status: "COMPLETED",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
      requestId: "REQ-POST-MERGE",
    });
    const transport = createGitHubRepositoryTransport({
      api: { graphql: graphql as GhCliApiClient["graphql"], rest: vi.fn() },
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(transport.fetchPostMergeStatus("owner/repo", "fedcba9")).resolves.toMatchObject({
      base_ref: "main",
      head_sha: "fedcba9",
      observed_base_sha: "fedcba9",
      post_merge_checks: [
        {
          conclusion: "success",
          name: "deploy / staging",
          status: "completed",
          target_sha: "fedcba9",
        },
      ],
      pr_number: 42,
      pr_state: "merged",
    });
  });

  it("normalizes one complete GraphQL PR snapshot and fails closed on nested pagination", async () => {
    const branch = githubBranchForWorkRef(workRef);
    const basic = {
      repository: {
        pullRequests: {
          nodes: [
            {
              baseRef: { target: { oid: "abc1234" } },
              baseRefName: "main",
              headRefName: branch,
              headRefOid: "def5678",
              id: "PR_node_42",
              isDraft: false,
              mergeable: "MERGEABLE",
              number: 42,
              reviewDecision: "APPROVED",
              state: "OPEN",
              url: "https://github.com/owner/repo/pull/42",
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const evidence = {
      node: {
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        checkSuite: { commit: { oid: "def5678" } },
                        conclusion: "SUCCESS",
                        detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                        isRequired: true,
                        name: "ci / required",
                        status: "COMPLETED",
                      },
                      {
                        __typename: "StatusContext",
                        commit: { oid: "def5678" },
                        context: "legacy",
                        isRequired: false,
                        state: "SUCCESS",
                        targetUrl: "https://ci.example.test/legacy",
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              comments: {
                nodes: [
                  {
                    author: { login: "reviewer" },
                    commit: { oid: "def5678" },
                    url: "https://github.com/owner/repo/pull/42#discussion_r1",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
              id: "thread-1",
              isOutdated: false,
              isResolved: false,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        reviews: {
          nodes: [
            {
              author: { login: "maintainer" },
              commit: { oid: "def5678" },
              state: "APPROVED",
              submittedAt: "2026-07-13T10:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ data: basic, requestId: "REQ-BASIC" })
      .mockResolvedValueOnce({ data: evidence, requestId: "REQ-EVIDENCE" });
    const transport = createGitHubRepositoryTransport({
      api: { graphql: graphql as GhCliApiClient["graphql"], rest: vi.fn() },
      commandRunner: { run: vi.fn() },
      configuredRequiredChecks: ["legacy"],
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });

    await expect(transport.fetchPullRequestSnapshot(workRef)).resolves.toMatchObject({
      base_ref: "main",
      checks: [
        {
          conclusion: "success",
          name: "ci / required",
          required_source: "protection",
          status: "completed",
          target_sha: "def5678",
        },
        {
          conclusion: "success",
          name: "legacy",
          required_source: "configured",
          status: "completed",
          target_sha: "def5678",
        },
      ],
      head_sha: "def5678",
      mergeable: true,
      observed_base_sha: "abc1234",
      required_check_source: "union",
      review_decision: "approved",
      unresolved_threads: [
        {
          author: "reviewer",
          commit_sha: "def5678",
          id: "thread-1",
          is_outdated: false,
        },
      ],
    });

    const partial = structuredClone(evidence);
    partial.node.reviewThreads.pageInfo.hasNextPage = true;
    const partialGraphql = vi
      .fn()
      .mockResolvedValueOnce({ data: basic, requestId: "REQ-BASIC" })
      .mockResolvedValueOnce({ data: partial, requestId: "REQ-PARTIAL" });
    const partialTransport = createGitHubRepositoryTransport({
      api: { graphql: partialGraphql as GhCliApiClient["graphql"], rest: vi.fn() },
      commandRunner: { run: vi.fn() },
      environment: {},
      repository: "owner/repo",
      timeoutMs: 5_000,
    });
    await expect(partialTransport.fetchPullRequestSnapshot(workRef)).rejects.toThrow(
      "github.pull_request_pagination_incomplete",
    );
  });
});

function api(rest: unknown): GhCliApiClient {
  return { graphql: vi.fn(), rest: rest as GhCliApiClient["rest"] };
}

function response<T>(data: T, requestId: string): GhRestResponse<T> {
  return { data, nextPageUrl: null, requestId };
}

function basicPullRequest(branch: string, headSha: string, baseSha: string) {
  return {
    repository: {
      pullRequests: {
        nodes: [
          {
            baseRef: { target: { oid: baseSha } },
            baseRefName: "main",
            headRefName: branch,
            headRefOid: headSha,
            id: "PR_node_42",
            isDraft: false,
            mergeable: "MERGEABLE",
            number: 42,
            reviewDecision: "APPROVED",
            state: "OPEN",
            url: "https://github.com/owner/repo/pull/42",
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
