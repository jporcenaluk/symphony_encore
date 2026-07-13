import type { MutationAuthorization } from "@symphony/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubTrackerAdapter,
  type GitHubProjectItem,
  type GitHubTrackerTransport,
} from "./github-tracker.js";
import type { ProviderMutationAuthority } from "./provider-authorization.js";

const item: GitHubProjectItem = {
  assigneeId: "user-1",
  blockedBy: [{ id: "issue-blocker", state: "In Progress" }],
  body: [
    "Context that is not acceptance criteria.",
    "",
    "## Acceptance Criteria",
    "- [ ] preserves durable state",
    "- [x] rejects partial pages",
    "",
    "## Notes",
    "- [ ] must not be treated as criteria",
  ].join("\n"),
  createdAt: "2026-07-13T09:00:00Z",
  id: "issue-node-1",
  labels: ["Bug", "CORE", "bug"],
  number: 123,
  priority: 2,
  repositoryName: "wheelsparrow",
  repositoryOwner: "jporc",
  revision: "revision-4",
  status: "Todo",
  title: "Implement the GitHub adapter",
  updatedAt: "2026-07-13T10:00:00Z",
  url: "https://github.com/jporc/wheelsparrow/issues/123",
};

const authorization: MutationAuthorization = {
  action: "tracker.update_lane",
  actor_id: "orchestrator",
  actor_kind: "orchestrator_policy",
  attempt_role: "implementation",
  authorized_at: "2026-07-13T10:00:00Z",
  config_snapshot_id: "config-1",
  decision_rule_ids: ["lane.transition.allowed"],
  expires_at: "2026-07-13T10:05:00Z",
  id: "authorization-1",
  idempotency_key: "intent-1",
  intent_id: "intent-1",
  observed_state_ref: "tracker:issue-node-1:revision-4",
  operator_capability: null,
  scope: "work",
  service_run_id: "run-1",
  target: "issue-node-1",
  target_revision: "revision-4",
  work_ref: { issue_id: "issue-node-1" },
};

function authority(overrides: Partial<ProviderMutationAuthority["expectation"]> = {}) {
  return {
    authorization,
    expectation: {
      action: "tracker.update_lane",
      actorId: "orchestrator",
      actorKind: "orchestrator_policy" as const,
      attemptRole: "implementation",
      configSnapshotId: "config-1",
      idempotencyKey: "intent-1",
      intentId: "intent-1",
      observedStateRef: "tracker:issue-node-1:revision-4",
      operatorCapability: null,
      scope: "work" as const,
      serviceRunId: "run-1",
      target: "issue-node-1",
      targetRevision: "revision-4",
      workRef: "issue:issue-node-1",
      ...overrides,
    },
  } satisfies ProviderMutationAuthority;
}

function transport(overrides: Partial<GitHubTrackerTransport> = {}) {
  return {
    fetchCandidatesPage: vi.fn(async () => ({ cursor: null, hasMore: false, items: [item] })),
    fetchCommentsPage: vi.fn(async () => ({ cursor: null, hasMore: false, items: [] })),
    fetchIssueRevision: vi.fn(async () => "revision-4"),
    fetchIssuesByStatesPage: vi.fn(async () => ({ cursor: null, hasMore: false, items: [item] })),
    fetchStatesByIdsPage: vi.fn(async () => ({
      cursor: null,
      hasMore: false,
      items: [{ id: item.id, revision: item.revision, state: item.status }],
    })),
    updateIssueLane: vi.fn(async () => ({
      providerRequestId: "request-1",
      responsePayloadHash: "sha256:response",
      result: "updated",
      resultRevision: "revision-5",
    })),
    upsertComment: vi.fn(async () => ({
      providerRequestId: "request-2",
      responsePayloadHash: "sha256:comment",
      result: "updated",
      resultRevision: "revision-5",
    })),
    ...overrides,
  } satisfies GitHubTrackerTransport;
}

describe("GitHub Projects tracker adapter", () => {
  it("normalizes labels, blockers, timestamps, lanes, and only the configured checklist section", async () => {
    const adapter = createGitHubTrackerAdapter(transport(), {
      acceptanceCriteriaHeading: "Acceptance Criteria",
      now: () => Date.parse("2026-07-13T10:01:00Z"),
    });

    await expect(adapter.fetchCandidates(null)).resolves.toEqual({
      cursor: null,
      hasMore: false,
      items: [
        {
          acceptance_criteria: ["preserves durable state", "rejects partial pages"],
          assignee_id: "user-1",
          blocked_by: [{ id: "issue-blocker", state: "In Progress" }],
          created_at: "2026-07-13T09:00:00.000Z",
          description: item.body,
          id: "issue-node-1",
          identifier: "jporc/wheelsparrow#123",
          labels: ["bug", "core"],
          priority: 2,
          repo_name: "wheelsparrow",
          repo_owner: "jporc",
          state: "Todo",
          title: "Implement the GitHub adapter",
          updated_at: "2026-07-13T10:00:00.000Z",
          url: item.url,
        },
      ],
    });
  });

  it("fails a provider operation whose page claims omitted results", async () => {
    const provider = transport({
      fetchCandidatesPage: vi.fn(async () => ({ cursor: null, hasMore: true, items: [] })),
    });
    const adapter = createGitHubTrackerAdapter(provider, {
      acceptanceCriteriaHeading: "Acceptance Criteria",
      now: Date.now,
    });

    await expect(adapter.fetchCandidates(null)).rejects.toThrow("pagination.missing_cursor");
  });

  it("normalizes the non-dispatchable Backlog lane for reconciliation", async () => {
    const adapter = createGitHubTrackerAdapter(
      transport({
        fetchIssuesByStatesPage: vi.fn(async () => ({
          cursor: null,
          hasMore: false,
          items: [{ ...item, status: "Backlog" }],
        })),
      }),
      { acceptanceCriteriaHeading: "Acceptance Criteria" },
    );

    await expect(adapter.fetchIssuesByStates(["Backlog"], null)).resolves.toMatchObject({
      items: [{ state: "Backlog" }],
    });
  });

  it("rechecks the provider revision before applying an exactly authorized lane mutation", async () => {
    const fetchIssueRevision = vi.fn(async () => "revision-4");
    const provider = transport({ fetchIssueRevision });
    const adapter = createGitHubTrackerAdapter(provider, {
      acceptanceCriteriaHeading: "Acceptance Criteria",
      now: () => Date.parse("2026-07-13T10:01:00Z"),
    });

    await expect(
      adapter.updateIssueLane("issue-node-1", "In Progress", "dispatch", authority()),
    ).resolves.toMatchObject({ providerRequestId: "request-1", resultRevision: "revision-5" });
    expect(provider.updateIssueLane).toHaveBeenCalledWith(
      "issue-node-1",
      "In Progress",
      "dispatch",
      "intent-1",
    );

    fetchIssueRevision.mockResolvedValueOnce("revision-5");
    await expect(
      adapter.updateIssueLane("issue-node-1", "Review", "attempt complete", authority()),
    ).rejects.toThrow("authorization.revision_mismatch");
    expect(provider.updateIssueLane).toHaveBeenCalledTimes(1);
  });
});
