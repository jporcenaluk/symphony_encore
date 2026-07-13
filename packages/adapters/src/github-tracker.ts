import type { Issue } from "@symphony/contracts";

import type {
  ProviderMutationResult,
  TrackerAdapter,
  TrackerComment,
  TrackerIssueState,
} from "./contracts.js";
import { AdapterContractError, type AdapterPage } from "./pagination.js";
import {
  assertProviderMutationAuthorization,
  ProviderAuthorizationError,
  type ProviderMutationAuthority,
} from "./provider-authorization.js";

const ISSUE_LANES = new Set<Issue["state"]>(["Todo", "In Progress", "Review", "Human", "Done"]);

export interface GitHubProjectItem {
  assigneeId: string | null;
  blockedBy: readonly { id: string; state: string }[];
  body: string;
  createdAt: string;
  id: string;
  labels: readonly string[];
  number: number;
  priority: number | null;
  repositoryName: string;
  repositoryOwner: string;
  revision: string;
  status: string;
  title: string;
  updatedAt: string;
  url: string;
}

export interface GitHubTrackerTransport {
  fetchCandidatesPage(cursor: string | null): Promise<AdapterPage<GitHubProjectItem>>;
  fetchCommentsPage(id: string, cursor: string | null): Promise<AdapterPage<TrackerComment>>;
  fetchIssueRevision(id: string): Promise<string>;
  fetchIssuesByStatesPage(
    states: readonly string[],
    cursor: string | null,
  ): Promise<AdapterPage<GitHubProjectItem>>;
  fetchStatesByIdsPage(
    ids: readonly string[],
    cursor: string | null,
  ): Promise<AdapterPage<TrackerIssueState>>;
  updateIssueLane(
    id: string,
    lane: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<ProviderMutationResult>;
  upsertComment(
    id: string,
    marker: string,
    body: string,
    idempotencyKey: string,
  ): Promise<ProviderMutationResult>;
}

export function createGitHubTrackerAdapter(
  transport: GitHubTrackerTransport,
  options: { acceptanceCriteriaHeading: string; now?: () => number },
): TrackerAdapter {
  const now = options.now ?? Date.now;
  return {
    async createOrUpdateComment(id, marker, body, authority) {
      const revision = await transport.fetchIssueRevision(id);
      assertOperationAuthority(authority, "tracker.create_or_update_comment", id, revision, now());
      return transport.upsertComment(id, marker, body, authority.expectation.idempotencyKey);
    },

    async fetchCandidates(cursor) {
      return normalizeIssuePage(
        await transport.fetchCandidatesPage(cursor),
        options.acceptanceCriteriaHeading,
      );
    },

    async fetchCommentsSince(id, cursor) {
      return assertCompletePage(await transport.fetchCommentsPage(id, cursor));
    },

    async fetchIssuesByStates(states, cursor) {
      return normalizeIssuePage(
        await transport.fetchIssuesByStatesPage(states, cursor),
        options.acceptanceCriteriaHeading,
      );
    },

    async fetchStatesByIds(ids, cursor) {
      return assertCompletePage(await transport.fetchStatesByIdsPage(ids, cursor));
    },

    async updateIssueLane(id, lane, reason, authority) {
      requireIssueLane(lane);
      const revision = await transport.fetchIssueRevision(id);
      assertOperationAuthority(authority, "tracker.update_lane", id, revision, now());
      return transport.updateIssueLane(id, lane, reason, authority.expectation.idempotencyKey);
    },
  };
}

function normalizeIssuePage(
  page: AdapterPage<GitHubProjectItem>,
  acceptanceCriteriaHeading: string,
): AdapterPage<Issue> {
  const complete = assertCompletePage(page);
  return {
    ...complete,
    items: complete.items.map((item) => normalizeIssue(item, acceptanceCriteriaHeading)),
  };
}

function normalizeIssue(item: GitHubProjectItem, acceptanceCriteriaHeading: string): Issue {
  requireIssueLane(item.status);
  if (!Number.isSafeInteger(item.number) || item.number <= 0) {
    throw new Error("github.invalid_issue_number");
  }
  if (item.priority !== null && !Number.isSafeInteger(item.priority)) {
    throw new Error("github.invalid_priority");
  }
  return {
    acceptance_criteria: extractChecklist(item.body, acceptanceCriteriaHeading),
    assignee_id: item.assigneeId,
    blocked_by: item.blockedBy.map((blocker) => ({ ...blocker })),
    created_at: normalizeTimestamp(item.createdAt),
    description: item.body,
    id: item.id,
    identifier: `${item.repositoryOwner}/${item.repositoryName}#${item.number}`,
    labels: [...new Set(item.labels.map((label) => label.toLocaleLowerCase("en-US")))].sort(),
    priority: item.priority,
    repo_name: item.repositoryName,
    repo_owner: item.repositoryOwner,
    state: item.status,
    title: item.title,
    updated_at: normalizeTimestamp(item.updatedAt),
    url: item.url,
  };
}

function extractChecklist(body: string, configuredHeading: string): string[] {
  let inSection = false;
  let headingLevel = 0;
  const criteria: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const title = heading[2]?.trim();
      if (
        !inSection &&
        title?.toLocaleLowerCase("en-US") === configuredHeading.toLocaleLowerCase("en-US")
      ) {
        inSection = true;
        headingLevel = heading[1]?.length ?? 0;
        continue;
      }
      if (inSection && (heading[1]?.length ?? 0) <= headingLevel) break;
      continue;
    }
    if (!inSection) continue;
    const checklist = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/u.exec(line);
    const criterion = checklist?.[1]?.trim();
    if (criterion) criteria.push(criterion);
  }
  return criteria;
}

function assertCompletePage<T>(page: AdapterPage<T>): AdapterPage<T> {
  if (page.hasMore && page.cursor === null) {
    throw new AdapterContractError("pagination.missing_cursor");
  }
  return page;
}

function assertOperationAuthority(
  authority: ProviderMutationAuthority,
  action: string,
  target: string,
  observedRevision: string,
  now: number,
): void {
  if (authority.expectation.action !== action) {
    throw new ProviderAuthorizationError("authorization.action_mismatch");
  }
  if (authority.expectation.target !== target) {
    throw new ProviderAuthorizationError("authorization.target_mismatch");
  }
  if (authority.expectation.targetRevision !== observedRevision) {
    throw new ProviderAuthorizationError("authorization.revision_mismatch");
  }
  if (authority.expectation.observedStateRef !== `tracker:${target}:${observedRevision}`) {
    throw new ProviderAuthorizationError("authorization.observed_state_mismatch");
  }
  assertProviderMutationAuthorization(authority.authorization, authority.expectation, now);
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("github.invalid_timestamp");
  return timestamp.toISOString();
}

function requireIssueLane(value: string): asserts value is Issue["state"] {
  if (!ISSUE_LANES.has(value as Issue["state"])) throw new Error("github.invalid_project_lane");
}
