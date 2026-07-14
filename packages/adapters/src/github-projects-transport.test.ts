import { describe, expect, it, vi } from "vitest";

import type { GhCliApiClient } from "./gh-cli-api.js";
import { createGitHubProjectsTransport } from "./github-projects-transport.js";

function api(responses: unknown[]) {
  const graphql = vi.fn(async () => {
    const data = responses.shift();
    if (data === undefined) throw new Error("unexpected graphql call");
    return { data, requestId: `request-${responses.length}` };
  });
  return { graphql } as unknown as GhCliApiClient & { graphql: typeof graphql };
}

const options = {
  owner: "octo-org",
  priorityField: "Priority",
  priorityOrder: ["P0", "P1", "P2"],
  projectNumber: 7,
  repositoryName: "wheelsparrow",
  repositoryOwner: "jporc",
  statusField: "Status",
};

const issueNode = {
  assignees: {
    nodes: [{ id: "user-1" }],
    pageInfo: { endCursor: "assignee-end", hasNextPage: false },
  },
  blockedBy: {
    nodes: [{ id: "blocker-1", state: "CLOSED" }],
    pageInfo: { endCursor: "blocker-end", hasNextPage: false },
  },
  body: "## Acceptance Criteria\n- [ ] works",
  createdAt: "2026-07-13T09:00:00Z",
  id: "issue-1",
  labels: {
    nodes: [{ name: "Ready" }],
    pageInfo: { endCursor: "label-end", hasNextPage: false },
  },
  number: 12,
  repository: { name: "wheelsparrow", owner: { login: "jporc" } },
  state: "OPEN",
  title: "Build transport",
  updatedAt: "2026-07-13T10:00:00Z",
  url: "https://github.com/jporc/wheelsparrow/issues/12",
};

describe("GitHub Projects v2 transport", () => {
  it("resolves an organization project and returns a complete normalized provider page", async () => {
    const client = api([
      {
        organization: { projectV2: { id: "project-1" } },
        user: null,
        viewer: { login: "symphony-bot" },
      },
      {
        node: {
          items: {
            nodes: [
              {
                content: issueNode,
                fieldValues: {
                  nodes: [
                    { field: { name: "Status" }, name: "Todo" },
                    { field: { name: "Priority" }, name: "P1" },
                  ],
                  pageInfo: { endCursor: "fields-end", hasNextPage: false },
                },
                id: "project-item-1",
                updatedAt: "2026-07-13T10:01:00Z",
              },
            ],
            pageInfo: { endCursor: "next-page", hasNextPage: true },
          },
        },
      },
    ]);
    const transport = createGitHubProjectsTransport(client, options);

    await expect(transport.fetchCandidatesPage(null)).resolves.toEqual({
      cursor: "next-page",
      hasMore: true,
      items: [
        {
          assigneeId: "user-1",
          blockedBy: [{ id: "blocker-1", state: "CLOSED" }],
          body: issueNode.body,
          createdAt: issueNode.createdAt,
          id: "issue-1",
          labels: ["Ready"],
          number: 12,
          priority: 1,
          repositoryName: "wheelsparrow",
          repositoryOwner: "jporc",
          revision: "2026-07-13T10:01:00Z:2026-07-13T10:00:00Z",
          status: "Todo",
          title: "Build transport",
          updatedAt: issueNode.updatedAt,
          url: issueNode.url,
        },
      ],
    });
    expect(client.graphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("query SymphonyResolveProject"),
      { number: 7, owner: "octo-org" },
    );
    expect(client.graphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("query SymphonyProjectItems"),
      { cursor: null, projectId: "project-1" },
    );
  });

  it("filters other repositories and states without corrupting outer pagination", async () => {
    const client = api([
      {
        organization: null,
        user: { projectV2: { id: "project-1" } },
        viewer: { login: "symphony-bot" },
      },
      {
        node: {
          items: {
            nodes: [
              {
                content: {
                  ...issueNode,
                  repository: { name: "somewhere-else", owner: { login: "jporc" } },
                },
                fieldValues: {
                  nodes: [{ field: { name: "Status" }, name: "Review" }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                id: "project-item-other",
                updatedAt: "2026-07-13T10:01:00Z",
              },
            ],
            pageInfo: { endCursor: "outer-next", hasNextPage: true },
          },
        },
      },
    ]);
    const transport = createGitHubProjectsTransport(client, options);

    await expect(transport.fetchIssuesByStatesPage(["Todo"], null)).resolves.toEqual({
      cursor: "outer-next",
      hasMore: true,
      items: [],
    });
  });

  it("treats a natively closed issue as Done even when its project field drifted", async () => {
    const client = api([
      { organization: { projectV2: { id: "project-1" } }, user: null, viewer: { login: "bot" } },
      {
        node: {
          items: {
            nodes: [
              {
                content: { ...issueNode, state: "CLOSED" },
                fieldValues: {
                  nodes: [{ field: { name: "Status" }, name: "Review" }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                id: "project-item-1",
                updatedAt: "2026-07-13T10:01:00Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    ]);

    await expect(
      createGitHubProjectsTransport(client, options).fetchIssuesByStatesPage(["Done"], null),
    ).resolves.toMatchObject({ items: [{ id: "issue-1", status: "Done" }] });
  });

  it("fails closed instead of truncating nested labels, blockers, assignees, or field values", async () => {
    const client = api([
      {
        organization: { projectV2: { id: "project-1" } },
        user: null,
        viewer: { login: "symphony-bot" },
      },
      {
        node: {
          items: {
            nodes: [
              {
                content: {
                  ...issueNode,
                  labels: {
                    ...issueNode.labels,
                    pageInfo: { endCursor: "more", hasNextPage: true },
                  },
                },
                fieldValues: {
                  nodes: [{ field: { name: "Status" }, name: "Todo" }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                id: "project-item-1",
                updatedAt: "2026-07-13T10:01:00Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    ]);

    await expect(
      createGitHubProjectsTransport(client, options).fetchCandidatesPage(null),
    ).rejects.toThrow("github.incomplete_nested_page");
  });

  it("updates the configured status option with a provider idempotency key and revision receipt", async () => {
    const client = api([
      {
        organization: { projectV2: { id: "project-1" } },
        user: null,
        viewer: { login: "symphony-bot" },
      },
      {
        issue: {
          projectItems: {
            nodes: [
              {
                id: "project-item-1",
                project: { id: "project-1" },
                updatedAt: "2026-07-13T10:01:00Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          updatedAt: "2026-07-13T10:00:00Z",
        },
        project: {
          fields: {
            nodes: [
              {
                id: "status-field-1",
                name: "Status",
                options: [
                  { id: "todo-option", name: "Todo" },
                  { id: "progress-option", name: "In Progress" },
                ],
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
      {
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            content: { updatedAt: "2026-07-13T10:00:00Z" },
            updatedAt: "2026-07-13T10:02:00Z",
          },
        },
      },
    ]);
    const transport = createGitHubProjectsTransport(client, options);

    await expect(
      transport.updateIssueLane("issue-1", "In Progress", "dispatch", "intent-123"),
    ).resolves.toMatchObject({
      providerRequestId: "request-0",
      result: "updated:dispatch",
      resultRevision: "2026-07-13T10:02:00Z:2026-07-13T10:00:00Z",
    });
    expect(client.graphql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("mutation SymphonyUpdateProjectLane"),
      {
        clientMutationId: "intent-123",
        fieldId: "status-field-1",
        itemId: "project-item-1",
        optionId: "progress-option",
        projectId: "project-1",
      },
    );
  });

  it("updates a marker comment idempotently and returns the reconciled tracker revision", async () => {
    const client = api([
      {
        organization: { projectV2: { id: "project-1" } },
        user: null,
        viewer: { login: "symphony-bot" },
      },
      {
        node: {
          comments: {
            edges: [
              {
                cursor: "comment-cursor-attacker",
                node: {
                  author: { login: "someone-else" },
                  body: "<!-- symphony:workpad -->\ndo not overwrite",
                  createdAt: "2026-07-13T08:00:00Z",
                  id: "comment-attacker",
                },
              },
              {
                cursor: "comment-cursor-1",
                node: {
                  author: { login: "symphony-bot" },
                  body: "<!-- symphony:workpad -->\nold",
                  createdAt: "2026-07-13T09:00:00Z",
                  id: "comment-1",
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
      { updateIssueComment: { issueComment: { id: "comment-1" } } },
      {
        issue: {
          projectItems: {
            nodes: [
              {
                id: "project-item-1",
                project: { id: "project-1" },
                updatedAt: "2026-07-13T10:03:00Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          updatedAt: "2026-07-13T10:00:00Z",
        },
        project: {
          fields: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
        },
      },
    ]);
    const transport = createGitHubProjectsTransport(client, options);

    await expect(
      transport.upsertComment(
        "issue-1",
        "<!-- symphony:workpad -->",
        "new projection",
        "intent-comment-1",
      ),
    ).resolves.toMatchObject({
      providerRequestId: "request-1",
      result: "updated",
      resultRevision: "2026-07-13T10:03:00Z:2026-07-13T10:00:00Z",
    });
    expect(client.graphql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("mutation SymphonyUpdateIssueComment"),
      expect.objectContaining({
        body: expect.stringContaining("<!-- symphony:workpad -->"),
        clientMutationId: "intent-comment-1",
        commentId: "comment-1",
      }),
    );
  });
});
