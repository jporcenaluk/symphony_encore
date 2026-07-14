import { createHash } from "node:crypto";

import type { GhCliApiClient } from "./gh-cli-api.js";
import type { GitHubProjectItem, GitHubTrackerTransport } from "./github-tracker.js";
import type { AdapterPage } from "./pagination.js";

const RESOLVE_PROJECT_QUERY = `
query SymphonyResolveProject($owner: String!, $number: Int!) {
  viewer { login }
  organization(login: $owner) { projectV2(number: $number) { id } }
  user(login: $owner) { projectV2(number: $number) { id } }
}`;

const PROJECT_ITEMS_QUERY = `
query SymphonyProjectItems($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        nodes {
          id
          updatedAt
          content {
            __typename
            ... on Issue {
              id number title body url state createdAt updatedAt
              repository { name owner { login } }
              assignees(first: 100) { nodes { id } pageInfo { hasNextPage endCursor } }
              labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }
              blockedBy(first: 100) { nodes { id state } pageInfo { hasNextPage endCursor } }
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const PROJECT_MUTATION_CONTEXT_QUERY = `
query SymphonyProjectMutationContext($projectId: ID!, $issueId: ID!) {
  project: node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  issue: node(id: $issueId) {
    ... on Issue {
      updatedAt
      projectItems(first: 100) {
        nodes {
          id updatedAt project { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const UPDATE_LANE_MUTATION = `
mutation SymphonyUpdateProjectLane(
  $projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!,
  $clientMutationId: String!
) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId },
    clientMutationId: $clientMutationId
  }) {
    projectV2Item {
      updatedAt
      content { ... on Issue { updatedAt } }
    }
  }
}`;

const ISSUE_COMMENTS_QUERY = `
query SymphonyIssueComments($issueId: ID!, $cursor: String) {
  node(id: $issueId) {
    ... on Issue {
      comments(first: 100, after: $cursor) {
        edges { cursor node { id body createdAt author { login } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ADD_COMMENT_MUTATION = `
mutation SymphonyAddIssueComment($issueId: ID!, $body: String!, $clientMutationId: String!) {
  addComment(input: { subjectId: $issueId, body: $body, clientMutationId: $clientMutationId }) {
    commentEdge { node { id } }
  }
}`;

const UPDATE_COMMENT_MUTATION = `
mutation SymphonyUpdateIssueComment($commentId: ID!, $body: String!, $clientMutationId: String!) {
  updateIssueComment(input: { id: $commentId, body: $body, clientMutationId: $clientMutationId }) {
    issueComment { id }
  }
}`;

export interface GitHubProjectsTransportOptions {
  owner: string;
  priorityField: string;
  priorityOrder: readonly string[];
  projectNumber: number;
  repositoryName: string;
  repositoryOwner: string;
  statusField: string;
}

interface PageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

interface IssueNode {
  assignees: Connection<{ id: string }>;
  blockedBy: Connection<{ id: string; state: string }>;
  body: string;
  createdAt: string;
  id: string;
  labels: Connection<{ name: string }>;
  number: number;
  repository: { name: string; owner: { login: string } };
  state: string;
  title: string;
  updatedAt: string;
  url: string;
}

interface ProjectItemNode {
  content: IssueNode | Record<string, unknown> | null;
  fieldValues: Connection<{ field?: { name?: string }; name?: string }>;
  id: string;
  updatedAt: string;
}

interface ProjectItemsData {
  node: { items: Connection<ProjectItemNode> } | null;
}

interface MutationContextData {
  issue: {
    projectItems: Connection<{ id: string; project: { id: string }; updatedAt: string }>;
    updatedAt: string;
  } | null;
  project: {
    fields: Connection<{
      id?: string;
      name?: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  } | null;
}

export function createGitHubProjectsTransport(
  api: GhCliApiClient,
  options: GitHubProjectsTransportOptions,
): GitHubTrackerTransport {
  let projectContextPromise: Promise<{ projectId: string; viewerLogin: string }> | null = null;

  const resolveProject = (): Promise<{ projectId: string; viewerLogin: string }> => {
    projectContextPromise ??= api
      .graphql<{
        organization: { projectV2: { id: string } | null } | null;
        user: { projectV2: { id: string } | null } | null;
        viewer: { login: string };
      }>(RESOLVE_PROJECT_QUERY, { number: options.projectNumber, owner: options.owner })
      .then(({ data }) => {
        const organizationProject = data.organization?.projectV2?.id;
        const userProject = data.user?.projectV2?.id;
        const id = organizationProject ?? userProject;
        if (!id) throw new Error("github.project_not_found");
        if (!data.viewer.login) throw new Error("github.viewer_missing");
        return { projectId: id, viewerLogin: data.viewer.login };
      })
      .catch((error: unknown) => {
        projectContextPromise = null;
        throw error;
      });
    return projectContextPromise;
  };

  const fetchProjectItems = async (
    cursor: string | null,
  ): Promise<AdapterPage<GitHubProjectItem>> => {
    const { projectId } = await resolveProject();
    const { data } = await api.graphql<ProjectItemsData>(PROJECT_ITEMS_QUERY, {
      cursor,
      projectId,
    });
    if (!data.node) throw new Error("github.project_not_found");
    const page = data.node.items;
    const items: GitHubProjectItem[] = [];
    for (const node of page.nodes) {
      const item = normalizeProjectItem(node, options);
      if (item) items.push(item);
    }
    return { cursor: page.pageInfo.endCursor, hasMore: page.pageInfo.hasNextPage, items };
  };

  const loadMutationContext = async (issueId: string) => {
    const { projectId } = await resolveProject();
    const { data } = await api.graphql<MutationContextData>(PROJECT_MUTATION_CONTEXT_QUERY, {
      issueId,
      projectId,
    });
    if (!data.project) throw new Error("github.project_not_found");
    if (!data.issue) throw new Error("github.issue_not_found");
    assertCompleteNestedPage(data.project.fields.pageInfo);
    const item = data.issue.projectItems.nodes.find(
      (candidate) => candidate.project.id === projectId,
    );
    if (!item) {
      if (data.issue.projectItems.pageInfo.hasNextPage)
        throw new Error("github.incomplete_nested_page");
      throw new Error("github.issue_not_in_project");
    }
    return {
      fields: data.project.fields.nodes,
      issueUpdatedAt: data.issue.updatedAt,
      item,
      projectId,
    };
  };

  const fetchCommentsPage: GitHubTrackerTransport["fetchCommentsPage"] = async (id, cursor) => {
    const { data } = await api.graphql<{
      node: {
        comments: {
          edges: Array<{
            cursor: string;
            node: {
              author: { login: string } | null;
              body: string;
              createdAt: string;
              id: string;
            };
          }>;
          pageInfo: PageInfo;
        };
      } | null;
    }>(ISSUE_COMMENTS_QUERY, { cursor, issueId: id });
    if (!data.node) throw new Error("github.issue_not_found");
    return {
      cursor: data.node.comments.pageInfo.endCursor,
      hasMore: data.node.comments.pageInfo.hasNextPage,
      items: data.node.comments.edges.map((edge) => ({
        authorId: edge.node.author?.login ?? "github.deleted_user",
        body: edge.node.body,
        createdAt: edge.node.createdAt,
        cursor: edge.cursor,
        id: edge.node.id,
      })),
    };
  };

  return {
    async fetchCandidatesPage(cursor) {
      const page = await fetchProjectItems(cursor);
      return { ...page, items: page.items.filter((item) => item.status === "Todo") };
    },
    fetchCommentsPage,
    async fetchIssueRevision(id) {
      const { issueUpdatedAt, item } = await loadMutationContext(id);
      return revision(item.updatedAt, issueUpdatedAt);
    },
    async fetchIssuesByStatesPage(states, cursor) {
      const accepted = new Set(states.map((state) => state.toLocaleLowerCase("en-US")));
      const page = await fetchProjectItems(cursor);
      return {
        ...page,
        items: page.items.filter((item) => accepted.has(item.status.toLocaleLowerCase("en-US"))),
      };
    },
    async fetchStatesByIdsPage(ids, cursor) {
      const accepted = new Set(ids);
      const page = await fetchProjectItems(cursor);
      return {
        cursor: page.cursor,
        hasMore: page.hasMore,
        items: page.items
          .filter((item) => accepted.has(item.id))
          .map((item) => ({ id: item.id, revision: item.revision, state: item.status })),
      };
    },
    async updateIssueLane(id, lane, reason, idempotencyKey) {
      const { fields, item, projectId } = await loadMutationContext(id);
      const statusField = fields.find((field) => field.name === options.statusField);
      if (!statusField?.id || !statusField.options)
        throw new Error("github.status_field_not_found");
      const option = statusField.options.find((candidate) => candidate.name === lane);
      if (!option) throw new Error("github.status_option_not_found");
      const response = await api.graphql<{
        updateProjectV2ItemFieldValue: {
          projectV2Item: { content: { updatedAt: string } | null; updatedAt: string } | null;
        } | null;
      }>(UPDATE_LANE_MUTATION, {
        clientMutationId: idempotencyKey,
        fieldId: statusField.id,
        itemId: item.id,
        optionId: option.id,
        projectId,
      });
      const updated = response.data.updateProjectV2ItemFieldValue?.projectV2Item;
      if (!updated?.content) throw new Error("github.invalid_mutation_response");
      return {
        providerRequestId: response.requestId,
        responsePayloadHash: payloadHash(response.data),
        result: `updated:${reason}`,
        resultRevision: revision(updated.updatedAt, updated.content.updatedAt),
      };
    },
    async upsertComment(id, marker, body, idempotencyKey) {
      const { viewerLogin } = await resolveProject();
      const idempotencyMarker = `<!-- symphony-idempotency:${idempotencyKey} -->`;
      const projection = body.includes(marker) ? body.trimEnd() : `${marker}\n${body.trimEnd()}`;
      const renderedBody = `${projection}\n\n${idempotencyMarker}`;
      let cursor: string | null = null;
      let existingId: string | null = null;
      do {
        const page = await fetchCommentsPage(id, cursor);
        existingId =
          page.items.find(
            (comment) =>
              comment.authorId === viewerLogin &&
              (comment.body.includes(marker) || comment.body.includes(idempotencyMarker)),
          )?.id ?? null;
        cursor = page.hasMore ? page.cursor : null;
        if (page.hasMore && cursor === null) throw new Error("pagination.missing_cursor");
      } while (!existingId && cursor !== null);

      const response = existingId
        ? await api.graphql<Record<string, unknown>>(UPDATE_COMMENT_MUTATION, {
            body: renderedBody,
            clientMutationId: idempotencyKey,
            commentId: existingId,
          })
        : await api.graphql<Record<string, unknown>>(ADD_COMMENT_MUTATION, {
            body: renderedBody,
            clientMutationId: idempotencyKey,
            issueId: id,
          });
      return {
        providerRequestId: response.requestId,
        responsePayloadHash: payloadHash(response.data),
        result: existingId ? "updated" : "created",
        resultRevision: await (async () => {
          const { issueUpdatedAt, item } = await loadMutationContext(id);
          return revision(item.updatedAt, issueUpdatedAt);
        })(),
      };
    },
  };
}

function normalizeProjectItem(
  node: ProjectItemNode,
  options: GitHubProjectsTransportOptions,
): GitHubProjectItem | null {
  const issue = node.content;
  if (!isIssueNode(issue)) return null;
  if (
    issue.repository.owner.login !== options.repositoryOwner ||
    issue.repository.name !== options.repositoryName
  ) {
    return null;
  }
  assertCompleteNestedPage(issue.assignees.pageInfo);
  assertCompleteNestedPage(issue.blockedBy.pageInfo);
  assertCompleteNestedPage(issue.labels.pageInfo);
  assertCompleteNestedPage(node.fieldValues.pageInfo);
  if (issue.assignees.nodes.length > 1) throw new Error("github.multiple_assignees");
  const projectStatus = singleSelectValue(node, options.statusField);
  if (!projectStatus) throw new Error("github.status_value_missing");
  const status = issue.state === "CLOSED" ? "Done" : projectStatus;
  const priorityName = singleSelectValue(node, options.priorityField);
  const priorityIndex = priorityName === null ? -1 : options.priorityOrder.indexOf(priorityName);
  return {
    assigneeId: issue.assignees.nodes[0]?.id ?? null,
    blockedBy: issue.blockedBy.nodes.map((blocker) => ({ id: blocker.id, state: blocker.state })),
    body: issue.body,
    createdAt: issue.createdAt,
    id: issue.id,
    labels: issue.labels.nodes.map((label) => label.name),
    number: issue.number,
    priority: priorityIndex < 0 ? null : priorityIndex,
    repositoryName: issue.repository.name,
    repositoryOwner: issue.repository.owner.login,
    revision: revision(node.updatedAt, issue.updatedAt),
    status,
    title: issue.title,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

function isIssueNode(value: ProjectItemNode["content"]): value is IssueNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "repository" in value &&
    typeof value.repository === "object" &&
    value.repository !== null
  );
}

function singleSelectValue(node: ProjectItemNode, fieldName: string): string | null {
  const value = node.fieldValues.nodes.find(
    (candidate) => candidate.field?.name === fieldName,
  )?.name;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function assertCompleteNestedPage(pageInfo: PageInfo): void {
  if (pageInfo.hasNextPage) throw new Error("github.incomplete_nested_page");
}

function revision(projectItemUpdatedAt: string, issueUpdatedAt: string): string {
  return `${projectItemUpdatedAt}:${issueUpdatedAt}`;
}

function payloadHash(payload: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
