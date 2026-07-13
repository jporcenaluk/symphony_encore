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
