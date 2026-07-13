import { createHash } from "node:crypto";
import type { EvidenceRef, PullRequestSnapshot, WorkRef } from "@symphony/contracts";

import type { ProviderMutationResult, PublishedBranch } from "./contracts.js";
import type { GhCliApiClient } from "./gh-cli-api.js";
import type { GitHubRepositoryHostingTransport } from "./github-repository-hosting.js";
import type { WorkspaceCommandRunner } from "./github-workspace.js";

const GIT_ENVIRONMENT_KEYS = [
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "XDG_CONFIG_HOME",
] as const;

interface GitReferenceResponse {
  object: { sha: string; type: string };
  ref: string;
}

interface PullRequestResponse {
  base: { ref: string };
  head: { ref: string; sha: string };
  html_url: string;
  number: number;
}

interface MergePullRequestResponse {
  merged: boolean;
  message: string;
  sha: string;
}

interface UpdatePullRequestBranchResponse {
  message: string;
  url: string;
}

interface PullRequestBasicNode {
  baseRef: { target: { oid: string } } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  id: string;
  isDraft: boolean;
  mergeable: string;
  number: number;
  reviewDecision: string | null;
  state: string;
  url: string;
}

interface PullRequestBasicResponse {
  repository: {
    pullRequests: {
      nodes: Array<PullRequestBasicNode | null>;
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

interface CheckRunNode {
  __typename: "CheckRun";
  checkSuite: { commit: { oid: string } } | null;
  conclusion: string | null;
  detailsUrl: string | null;
  isRequired?: boolean;
  name: string;
  status: string;
}

interface StatusContextNode {
  __typename: "StatusContext";
  commit: { oid: string };
  context: string;
  isRequired?: boolean;
  state: string;
  targetUrl: string | null;
}

interface PullRequestEvidenceResponse {
  node: {
    commits: {
      nodes: Array<{
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: Array<CheckRunNode | StatusContextNode | null>;
              pageInfo: { hasNextPage: boolean };
            };
          } | null;
        };
      }>;
    };
    reviews: {
      nodes: Array<{
        author: { login: string } | null;
        commit: { oid: string } | null;
        state: string;
        submittedAt: string | null;
      } | null>;
      pageInfo: { hasNextPage: boolean };
    };
    reviewThreads: {
      nodes: Array<{
        comments: {
          nodes: Array<{
            author: { login: string } | null;
            commit: { oid: string } | null;
            url: string;
          }>;
          pageInfo: { hasNextPage: boolean };
        };
        id: string;
        isOutdated: boolean;
        isResolved: boolean;
      } | null>;
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

interface PostMergeStatusResponse {
  repository: {
    object: {
      associatedPullRequests: {
        nodes: Array<{
          baseRefName: string;
          isDraft: boolean;
          number: number;
          state: string;
          url: string;
        } | null>;
        pageInfo: { hasNextPage: boolean };
      };
      oid: string;
      statusCheckRollup: {
        contexts: {
          nodes: Array<CheckRunNode | StatusContextNode | null>;
          pageInfo: { hasNextPage: boolean };
        };
      } | null;
    } | null;
  } | null;
}

const PULL_REQUEST_BASIC_QUERY = `
  query SymphonyPullRequest($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 2
        headRefName: $branch
        states: [OPEN]
        orderBy: {field: UPDATED_AT, direction: DESC}
      ) {
        pageInfo { hasNextPage }
        nodes {
          id number url state isDraft mergeable reviewDecision headRefName headRefOid baseRefName
          baseRef { target { oid } }
        }
      }
    }
  }
`;

const PULL_REQUEST_EVIDENCE_QUERY = `
  query SymphonyPullRequestEvidence($id: ID!, $number: Int!) {
    node(id: $id) {
      ... on PullRequest {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
                      checkSuite { commit { oid } }
                    }
                    ... on StatusContext {
                      context state targetUrl isRequired(pullRequestNumber: $number)
                      commit { oid }
                    }
                  }
                }
              }
            }
          }
        }
        reviews(first: 100) {
          pageInfo { hasNextPage }
          nodes { author { login } state commit { oid } submittedAt }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            id isResolved isOutdated
            comments(first: 1) {
              pageInfo { hasNextPage }
              nodes { author { login } url commit { oid } }
            }
          }
        }
      }
    }
  }
`;

const POST_MERGE_STATUS_QUERY = `
  query SymphonyPostMergeStatus($owner: String!, $name: String!, $sha: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $sha) {
        ... on Commit {
          oid
          associatedPullRequests(first: 2, states: [MERGED]) {
            pageInfo { hasNextPage }
            nodes { number url state isDraft baseRefName }
          }
          statusCheckRollup {
            contexts(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                ... on CheckRun {
                  name status conclusion detailsUrl
                  checkSuite { commit { oid } }
                }
                ... on StatusContext {
                  context state targetUrl
                  commit { oid }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export function createGitHubRepositoryTransport(options: {
  api: GhCliApiClient;
  commandRunner: WorkspaceCommandRunner;
  configuredRequiredChecks?: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  repository: string;
  timeoutMs: number;
}): GitHubRepositoryHostingTransport {
  const { name, owner } = parseRepository(options.repository);
  const gitEnvironment = allowlistedEnvironment(options.environment, GIT_ENVIRONMENT_KEYS);
  return {
    async createRepairPullRequest(
      workRef: WorkRef,
      failedMergeSha: string,
      evidence: readonly EvidenceRef[],
      idempotencyKey: string,
    ) {
      void workRef;
      void failedMergeSha;
      void evidence;
      void idempotencyKey;
      throw new Error("github.create_repair_pull_request_not_implemented");
    },

    async ensurePullRequest(workRef, headSha, baseRef, bodyProjection, idempotencyKey) {
      const branch = githubBranchForWorkRef(workRef);
      const existing = await findOpenPullRequest(options.api, owner, name, branch);
      const response = existing
        ? await options.api.rest<PullRequestResponse>({
            body: { base: baseRef, body: bodyProjection },
            method: "PATCH",
            path: `repos/${owner}/${name}/pulls/${existing.number}`,
          })
        : await options.api.rest<PullRequestResponse>({
            body: {
              base: baseRef,
              body: bodyProjection,
              head: branch,
              title: pullRequestTitle(workRef),
            },
            method: "POST",
            path: `repos/${owner}/${name}/pulls`,
          });
      const pullRequest = response.data;
      if (
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number < 1 ||
        !pullRequest.html_url ||
        pullRequest.head.ref !== branch ||
        pullRequest.head.sha !== headSha ||
        pullRequest.base.ref !== baseRef
      ) {
        throw new Error("github.pull_request_response_invalid");
      }
      return {
        mutation: mutation(response.requestId, existing ? "updated" : "created", headSha, {
          idempotencyKey,
          number: pullRequest.number,
          url: pullRequest.html_url,
        }),
        number: pullRequest.number,
        url: pullRequest.html_url,
      };
    },

    async fetchBranchSha(workRef) {
      return (await fetchBranchReference(options.api, owner, name, githubBranchForWorkRef(workRef)))
        .data.object.sha;
    },

    async fetchCommitSha(sha) {
      const response = await options.api.rest<{ sha: string }>({
        method: "GET",
        path: `repos/${owner}/${name}/commits/${encodeURIComponent(sha)}`,
      });
      if (!isSha(response.data.sha)) throw new Error("github.commit_response_invalid");
      return response.data.sha;
    },

    async fetchDefaultBranchSha() {
      const metadata = await options.api.rest<{ default_branch: string }>({
        method: "GET",
        path: `repos/${owner}/${name}`,
      });
      if (!metadata.data.default_branch) throw new Error("github.repository_response_invalid");
      return (await fetchBranchReference(options.api, owner, name, metadata.data.default_branch))
        .data.object.sha;
    },

    async fetchPostMergeStatus(repository: string, mergeSha: string) {
      if (repository !== options.repository) throw new Error("github.repository_mismatch");
      if (!isSha(mergeSha)) throw new Error("github.merge_sha_invalid");
      const response = await options.api.graphql<PostMergeStatusResponse>(POST_MERGE_STATUS_QUERY, {
        name,
        owner,
        sha: mergeSha,
      });
      return normalizePostMergeStatus(response.data, mergeSha);
    },

    async fetchPullRequestSnapshot(workRef: WorkRef) {
      const pullRequest = await loadPullRequestBasic(
        options.api,
        owner,
        name,
        githubBranchForWorkRef(workRef),
      );
      const evidence = await options.api.graphql<PullRequestEvidenceResponse>(
        PULL_REQUEST_EVIDENCE_QUERY,
        { id: pullRequest.id, number: pullRequest.number },
      );
      return normalizePullRequestSnapshot(
        pullRequest,
        evidence.data,
        options.configuredRequiredChecks ?? [],
      );
    },

    async mergePullRequest(
      workRef: WorkRef,
      expectedHeadSha: string,
      landingPolicy: string,
      idempotencyKey: string,
    ) {
      if (!isLandingPolicy(landingPolicy)) throw new Error("github.landing_policy_invalid");
      const pullRequest = await loadPullRequestBasic(
        options.api,
        owner,
        name,
        githubBranchForWorkRef(workRef),
      );
      if (pullRequest.headRefOid !== expectedHeadSha) throw new Error("github.stale_head");
      const response = await options.api.rest<MergePullRequestResponse>({
        body: { merge_method: landingPolicy, sha: expectedHeadSha },
        method: "PUT",
        path: `repos/${owner}/${name}/pulls/${pullRequest.number}/merge`,
      });
      if (!response.data.merged || !isSha(response.data.sha)) {
        throw new Error("github.merge_response_invalid");
      }
      return {
        mergeSha: response.data.sha,
        mutation: mutation(response.requestId, "merged", response.data.sha, {
          idempotencyKey,
          landingPolicy,
          message: response.data.message,
          number: pullRequest.number,
        }),
      };
    },

    async publishBranch(workRef, workspace, _expectedBaseSha, idempotencyKey) {
      const branch = githubBranchForWorkRef(workRef);
      const headSha = (
        await runGit(options.commandRunner, {
          arguments: ["-C", workspace, "rev-parse", "HEAD"],
          cwd: workspace,
          environment: gitEnvironment,
          timeoutMs: options.timeoutMs,
        })
      ).trim();
      if (!isSha(headSha)) throw new Error("github.local_head_invalid");
      const remoteRef = `refs/heads/${branch}`;
      const remoteOutput = await runGit(options.commandRunner, {
        arguments: ["-C", workspace, "ls-remote", "--heads", "origin", remoteRef],
        cwd: workspace,
        environment: gitEnvironment,
        timeoutMs: options.timeoutMs,
      });
      const remoteSha = parseRemoteSha(remoteOutput, remoteRef);
      await runGit(options.commandRunner, {
        arguments: [
          "-C",
          workspace,
          "push",
          "origin",
          `HEAD:${remoteRef}`,
          `--force-with-lease=${remoteRef}:${remoteSha ?? ""}`,
        ],
        cwd: workspace,
        environment: gitEnvironment,
        timeoutMs: options.timeoutMs,
      });
      const confirmed = await fetchBranchReference(options.api, owner, name, branch);
      if (confirmed.data.object.sha !== headSha) throw new Error("github.published_head_mismatch");
      return {
        branch,
        headSha,
        mutation: mutation(confirmed.requestId, "published", headSha, {
          branch,
          idempotencyKey,
          priorHeadSha: remoteSha,
        }),
      } satisfies PublishedBranch;
    },

    async updateBranch(
      workRef: WorkRef,
      expectedHeadSha: string,
      expectedBaseSha: string,
      idempotencyKey: string,
    ) {
      const branch = githubBranchForWorkRef(workRef);
      const pullRequest = await loadPullRequestBasic(options.api, owner, name, branch);
      if (pullRequest.headRefOid !== expectedHeadSha) throw new Error("github.stale_head");
      if (pullRequest.baseRef?.target.oid !== expectedBaseSha) throw new Error("github.stale_base");
      const response = await options.api.rest<UpdatePullRequestBranchResponse>({
        body: { expected_head_sha: expectedHeadSha },
        method: "PUT",
        path: `repos/${owner}/${name}/pulls/${pullRequest.number}/update-branch`,
      });
      if (!response.data.message || !response.data.url) {
        throw new Error("github.update_branch_response_invalid");
      }
      const confirmed = await fetchBranchReference(options.api, owner, name, branch);
      const headSha = confirmed.data.object.sha;
      if (headSha === expectedHeadSha) throw new Error("github.update_branch_incomplete");
      return {
        branch,
        headSha,
        mutation: mutation(response.requestId, "updated", headSha, {
          baseSha: expectedBaseSha,
          idempotencyKey,
          message: response.data.message,
          number: pullRequest.number,
        }),
      };
    },
  };
}

export function githubBranchForWorkRef(workRef: WorkRef): string {
  const kind = "issue_id" in workRef ? "issue" : "system-job";
  const id = "issue_id" in workRef ? workRef.issue_id : workRef.system_job_id;
  const digest = createHash("sha256").update(`${kind}:${id}`).digest("hex").slice(0, 16);
  return `symphony/${kind}-${digest}`;
}

async function loadPullRequestBasic(
  api: GhCliApiClient,
  owner: string,
  name: string,
  branch: string,
): Promise<PullRequestBasicNode> {
  const response = await api.graphql<PullRequestBasicResponse>(PULL_REQUEST_BASIC_QUERY, {
    branch,
    name,
    owner,
  });
  const connection = response.data.repository?.pullRequests;
  if (!connection || connection.pageInfo.hasNextPage || connection.nodes.length !== 1) {
    throw new Error(
      connection?.pageInfo.hasNextPage
        ? "github.pull_request_pagination_incomplete"
        : "github.pull_request_identity_invalid",
    );
  }
  const pullRequest = connection.nodes[0];
  if (
    !pullRequest ||
    pullRequest.headRefName !== branch ||
    !isSha(pullRequest.headRefOid) ||
    !pullRequest.baseRefName ||
    !isSha(pullRequest.baseRef?.target.oid ?? "") ||
    !pullRequest.id ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number < 1 ||
    !pullRequest.url
  ) {
    throw new Error("github.pull_request_response_invalid");
  }
  return pullRequest;
}

function normalizePullRequestSnapshot(
  pullRequest: PullRequestBasicNode,
  response: PullRequestEvidenceResponse,
  configuredRequiredChecks: readonly string[],
): PullRequestSnapshot {
  const evidence = response.node;
  const commit = evidence?.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  if (
    !evidence ||
    !commit ||
    evidence.reviews.pageInfo.hasNextPage ||
    evidence.reviewThreads.pageInfo.hasNextPage ||
    contexts?.pageInfo.hasNextPage ||
    evidence.reviewThreads.nodes.some((thread) => thread?.comments.pageInfo.hasNextPage)
  ) {
    throw new Error("github.pull_request_pagination_incomplete");
  }
  const configured = new Set(configuredRequiredChecks);
  let protectionRequired = false;
  const checks = (contexts?.nodes ?? []).map((context) => {
    if (!context) throw new Error("github.pull_request_check_incomplete");
    const normalized = normalizeCheck(context, pullRequest.url);
    const configuredRequired = configured.has(normalized.name);
    protectionRequired ||= context.isRequired === true;
    const required_source = context.isRequired
      ? configuredRequired
        ? ("union" as const)
        : ("protection" as const)
      : configuredRequired
        ? ("configured" as const)
        : undefined;
    return { ...normalized, ...(required_source === undefined ? {} : { required_source }) };
  });
  const reviews = evidence.reviews.nodes.map((review) => {
    if (!review) throw new Error("github.pull_request_review_incomplete");
    if (!review.author?.login || !review.commit?.oid || !review.submittedAt) {
      throw new Error("github.pull_request_review_incomplete");
    }
    return {
      author: review.author.login,
      commit_sha: review.commit.oid,
      state: review.state.toLocaleLowerCase("en-US"),
      submitted_at: normalizeTimestamp(review.submittedAt),
    };
  });
  const unresolved_threads = evidence.reviewThreads.nodes
    .map((thread) => {
      if (!thread) throw new Error("github.pull_request_thread_incomplete");
      return thread;
    })
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const comment = thread.comments.nodes[0];
      if (!thread.id || !comment?.author?.login || !comment.commit?.oid || !comment.url) {
        throw new Error("github.pull_request_thread_incomplete");
      }
      return {
        author: comment.author.login,
        commit_sha: comment.commit.oid,
        id: thread.id,
        is_outdated: thread.isOutdated,
        url: comment.url,
      };
    });
  return {
    base_ref: pullRequest.baseRefName,
    checks,
    head_sha: pullRequest.headRefOid,
    is_draft: pullRequest.isDraft,
    mergeable: normalizeMergeable(pullRequest.mergeable),
    observed_base_sha: pullRequest.baseRef?.target.oid ?? "",
    post_merge_checks: [],
    pr_number: pullRequest.number,
    pr_state: normalizePullRequestState(pullRequest.state),
    pr_url: pullRequest.url,
    required_check_source:
      configured.size > 0 && protectionRequired
        ? "union"
        : protectionRequired
          ? "protection"
          : "configured",
    review_decision: normalizeReviewDecision(pullRequest.reviewDecision),
    reviews,
    unresolved_threads,
  };
}

function normalizePostMergeStatus(
  response: PostMergeStatusResponse,
  mergeSha: string,
): PullRequestSnapshot {
  const commit = response.repository?.object;
  const connection = commit?.associatedPullRequests;
  const contexts = commit?.statusCheckRollup?.contexts;
  if (
    !commit ||
    commit.oid !== mergeSha ||
    !connection ||
    connection.pageInfo.hasNextPage ||
    connection.nodes.length !== 1 ||
    contexts?.pageInfo.hasNextPage
  ) {
    throw new Error(
      connection?.pageInfo.hasNextPage || contexts?.pageInfo.hasNextPage
        ? "github.post_merge_pagination_incomplete"
        : "github.post_merge_identity_invalid",
    );
  }
  const pullRequest = connection.nodes[0];
  if (
    pullRequest?.state !== "MERGED" ||
    !pullRequest.baseRefName ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number < 1 ||
    !pullRequest.url
  ) {
    throw new Error("github.post_merge_response_invalid");
  }
  const post_merge_checks = (contexts?.nodes ?? []).map((context) => {
    if (!context) throw new Error("github.pull_request_check_incomplete");
    return normalizeCheck(context, pullRequest.url);
  });
  return {
    base_ref: pullRequest.baseRefName,
    checks: [],
    head_sha: mergeSha,
    is_draft: pullRequest.isDraft,
    mergeable: true,
    observed_base_sha: mergeSha,
    post_merge_checks,
    pr_number: pullRequest.number,
    pr_state: "merged",
    pr_url: pullRequest.url,
    required_check_source: "configured",
    review_decision: "none",
    reviews: [],
    unresolved_threads: [],
  };
}

function normalizeCheck(
  context: CheckRunNode | StatusContextNode,
  fallbackUrl: string,
): {
  conclusion: string | null;
  name: string;
  status: string;
  target_sha: string;
  url: string;
} {
  if (context.__typename === "CheckRun") {
    const targetSha = context.checkSuite?.commit.oid;
    if (!context.name || !targetSha || !isSha(targetSha)) {
      throw new Error("github.pull_request_check_incomplete");
    }
    return {
      conclusion: context.conclusion?.toLocaleLowerCase("en-US") ?? null,
      name: context.name,
      status: context.status.toLocaleLowerCase("en-US"),
      target_sha: targetSha,
      url: context.detailsUrl || fallbackUrl,
    };
  }
  if (!context.context || !isSha(context.commit.oid)) {
    throw new Error("github.pull_request_check_incomplete");
  }
  const state = context.state.toLocaleLowerCase("en-US");
  return {
    conclusion: state === "pending" || state === "expected" ? null : state,
    name: context.context,
    status: state === "pending" || state === "expected" ? "in_progress" : "completed",
    target_sha: context.commit.oid,
    url: context.targetUrl || fallbackUrl,
  };
}

function normalizeMergeable(value: string): boolean | null {
  if (value === "MERGEABLE") return true;
  if (value === "CONFLICTING") return false;
  if (value === "UNKNOWN") return null;
  throw new Error("github.pull_request_mergeability_invalid");
}

function normalizePullRequestState(value: string): "closed" | "merged" | "open" {
  if (value === "OPEN") return "open";
  if (value === "CLOSED") return "closed";
  if (value === "MERGED") return "merged";
  throw new Error("github.pull_request_state_invalid");
}

function normalizeReviewDecision(value: string | null): "approved" | "changes_requested" | "none" {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === null || value === "REVIEW_REQUIRED") return "none";
  throw new Error("github.pull_request_review_decision_invalid");
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("github.timestamp_invalid");
  return parsed.toISOString();
}

async function findOpenPullRequest(
  api: GhCliApiClient,
  owner: string,
  name: string,
  branch: string,
): Promise<PullRequestResponse | null> {
  const response = await api.rest<PullRequestResponse[]>({
    method: "GET",
    path: `repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(
      `${owner}:${branch}`,
    )}&per_page=100`,
  });
  if (response.nextPageUrl !== null || response.data.length > 1) {
    throw new Error("github.pull_request_identity_ambiguous");
  }
  return response.data[0] ?? null;
}

async function fetchBranchReference(
  api: GhCliApiClient,
  owner: string,
  name: string,
  branch: string,
) {
  const response = await api.rest<GitReferenceResponse>({
    method: "GET",
    path: `repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
  });
  if (
    response.data.ref !== `refs/heads/${branch}` ||
    response.data.object.type !== "commit" ||
    !isSha(response.data.object.sha)
  ) {
    throw new Error("github.branch_response_invalid");
  }
  return response;
}

async function runGit(
  runner: WorkspaceCommandRunner,
  request: {
    arguments: readonly string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
    timeoutMs: number;
  },
): Promise<string> {
  const result = await runner.run({
    ...request,
    command: "git",
    maxOutputBytes: 1_000_000,
  });
  if (result.exitCode !== 0) throw new Error("github.git_failed");
  return result.stdout;
}

function parseRemoteSha(value: string, expectedRef: string): string | null {
  if (!value.trim()) return null;
  const lines = value.trim().split(/\r?\n/u);
  if (lines.length !== 1) throw new Error("github.remote_ref_ambiguous");
  const [sha, ref, extra] = lines[0]?.split(/\s+/u) ?? [];
  if (!sha || ref !== expectedRef || extra !== undefined || !isSha(sha)) {
    throw new Error("github.remote_ref_invalid");
  }
  return sha;
}

function mutation(
  providerRequestId: string,
  result: string,
  resultRevision: string | null,
  payload: unknown,
): ProviderMutationResult {
  return {
    providerRequestId,
    responsePayloadHash: `sha256:${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`,
    result,
    resultRevision,
  };
}

function pullRequestTitle(workRef: WorkRef): string {
  return "issue_id" in workRef
    ? `Symphony issue ${workRef.issue_id}`
    : `Symphony system job ${workRef.system_job_id}`;
}

function parseRepository(repository: string): { name: string; owner: string } {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra !== undefined) throw new Error("github.repository_invalid");
  return { name, owner };
}

function isSha(value: string): boolean {
  return /^[A-Fa-f0-9]{7,64}$/u.test(value);
}

function isLandingPolicy(value: string): value is "merge" | "rebase" | "squash" {
  return value === "merge" || value === "rebase" || value === "squash";
}

function allowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  return environment;
}
