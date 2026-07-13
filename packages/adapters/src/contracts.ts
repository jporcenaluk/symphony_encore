import type {
  AgentAdapterManifest,
  AgentEvent,
  EvidenceRef,
  Issue,
  PullRequestSnapshot,
  WorkRef,
} from "@symphony/contracts";

import type { AdapterPage } from "./pagination.js";
import type { ProviderMutationAuthority } from "./provider-authorization.js";

export interface ProviderMutationResult {
  providerRequestId: string;
  result: string;
  resultRevision: string | null;
  responsePayloadHash: string;
}

export interface TrackerIssueState {
  id: string;
  state: string;
  revision: string;
}

export interface TrackerComment {
  authorId: string;
  body: string;
  createdAt: string;
  cursor: string;
  id: string;
}

export interface TrackerAdapter {
  createOrUpdateComment(
    id: string,
    marker: string,
    body: string,
    authority: ProviderMutationAuthority,
  ): Promise<ProviderMutationResult>;
  ensureProjectSchema?: (
    project: string,
    statusField: string,
    lanes: readonly string[],
    priorityField: string,
  ) => Promise<void>;
  fetchCandidates(cursor: string | null): Promise<AdapterPage<Issue>>;
  fetchCommentsSince(id: string, cursor: string | null): Promise<AdapterPage<TrackerComment>>;
  fetchIssuesByStates(
    states: readonly string[],
    cursor: string | null,
  ): Promise<AdapterPage<Issue>>;
  fetchStatesByIds(
    ids: readonly string[],
    cursor: string | null,
  ): Promise<AdapterPage<TrackerIssueState>>;
  updateIssueLane(
    id: string,
    lane: string,
    reason: string,
    authority: ProviderMutationAuthority,
  ): Promise<ProviderMutationResult>;
}

export interface PublishedBranch {
  branch: string;
  headSha: string;
  mutation: ProviderMutationResult;
}

export interface PullRequestIdentity {
  number: number;
  url: string;
  mutation: ProviderMutationResult;
}

export interface MergeResult {
  mergeSha: string;
  mutation: ProviderMutationResult;
}

export interface RepositoryHostingAdapter {
  createRepairPullRequest(
    workRef: WorkRef,
    failedMergeSha: string,
    evidence: readonly EvidenceRef[],
    authority: ProviderMutationAuthority,
  ): Promise<PullRequestIdentity>;
  ensurePullRequest(
    workRef: WorkRef,
    headSha: string,
    baseRef: string,
    bodyProjection: string,
    authority: ProviderMutationAuthority,
  ): Promise<PullRequestIdentity>;
  fetchPostMergeStatus(repository: string, mergeSha: string): Promise<PullRequestSnapshot>;
  fetchPullRequestSnapshot(workRef: WorkRef): Promise<PullRequestSnapshot>;
  mergePullRequest(
    workRef: WorkRef,
    expectedHeadSha: string,
    landingPolicy: string,
    authority: ProviderMutationAuthority,
  ): Promise<MergeResult>;
  publishBranch(
    workRef: WorkRef,
    workspace: string,
    expectedBaseSha: string,
    authority: ProviderMutationAuthority,
  ): Promise<PublishedBranch>;
  updateBranch(
    workRef: WorkRef,
    expectedHeadSha: string,
    expectedBaseSha: string,
    authority: ProviderMutationAuthority,
  ): Promise<PublishedBranch>;
}

export interface AgentPreflightRequest {
  requiredCapabilities: readonly string[];
  requiredSkills: readonly { contentHash: string; name: string; resolvedPath: string }[];
  role: string;
  submitPlanSchema?: Readonly<Record<string, unknown>>;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}

export interface AgentPreflightResult {
  adapterVersion: string;
  manifest: AgentAdapterManifest;
  protocolSchemaHash: string;
  resolvedSkills: readonly { contentHash: string; name: string; resolvedPath: string }[];
  role: string;
  submitPlanSchema: Readonly<Record<string, unknown>> | null;
  terminalResultSchema: Readonly<Record<string, unknown>>;
}

export interface AgentLaunchRequest {
  attemptId: string;
  command: string;
  environment: Readonly<Record<string, string>>;
  onPlanSubmitted?: (plan: unknown) => Promise<AgentPlanSubmissionDecision>;
  preflight: AgentPreflightResult;
  profile: "deep" | "economy" | "standard";
  prompt: string;
  title: string;
  workspacePath: string;
}

export interface AgentPlanSubmissionDecision {
  accepted: boolean;
  message: string;
}

export interface AgentSession {
  cancel(reason: string): Promise<void>;
  events: AsyncIterable<AgentEvent>;
  processGroupId: number;
  processId: number;
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
}

export interface AgentAdapter {
  launch(request: AgentLaunchRequest): Promise<AgentSession>;
  manifest(): Promise<AgentAdapterManifest>;
  preflight(request: AgentPreflightRequest): Promise<AgentPreflightResult>;
}

export interface WorkspacePopulation {
  baseRef: string;
  baseSha: string;
  checkoutMethod: "operator_managed_mirror" | "trusted_repository_adapter";
  createdAt: string;
  localBranch: string;
  repository: string;
  workspacePath: string;
}

export interface WorkspaceRepositoryAdapter {
  populateIssueWorkspace(input: {
    identifier: string;
    repository: string;
    workspaceRoot: string;
  }): Promise<WorkspacePopulation>;
}
