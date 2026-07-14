import type { AgentAdapterManifest, Issue } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { composeInitialIssueDispatch } from "./issue-dispatch-record.js";

const issue: Issue = {
  acceptance_criteria: ["Ship the implementation"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Implement it",
  id: "issue-1",
  identifier: "ORG/repo#1",
  labels: ["ready"],
  priority: 1,
  repo_name: "repo",
  repo_owner: "ORG",
  state: "Todo",
  title: "Implement feature",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/1",
};

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-app-server-v2:test",
  capabilities: ["terminal_result", "submit_plan", "skills"],
  price_table: null,
  profiles: {
    deep: { model: "gpt-test", reasoning_effort: "high" },
    economy: { model: "gpt-test", reasoning_effort: "low" },
    standard: { model: "gpt-test", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:protocol" },
};

describe("initial issue dispatch record composition", () => {
  it("pins route, budget, claim, event, intent, and exact provider authority", () => {
    const result = composeInitialIssueDispatch({
      attemptId: "attempt-1",
      attemptNumber: 1,
      authorizationId: "authorization-1",
      budgetLedgers: [
        { amount: 200_000, id: "attempt-ledger", version: 1 },
        { amount: 200_000, id: "issue-ledger", version: 2 },
        { amount: 200_000, id: "fleet-ledger", version: 3 },
      ],
      changeClass: "standard",
      classificationReasons: ["classification.unknown"],
      configSnapshotId: "config-1",
      eventId: "event-1",
      intentId: "intent-1",
      issue,
      leaseExpiresAt: "2026-07-13T10:02:00Z",
      manifest,
      now: "2026-07-13T10:00:00Z",
      providerRevision: "revision-1",
      reservationId: "reservation-1",
      route: {
        model: "gpt-test",
        profile: "standard",
        reasoningEffort: "medium",
        reasons: ["route.implementation.standard"],
      },
      serviceRunId: "run-1",
      stageTransitionId: "stage-2",
      workspacePath: "/tmp/work/ORG_repo_1",
    });

    expect(result.dispatch).toMatchObject({
      attempt: {
        changeClass: "standard",
        computeProfile: "standard",
        configSnapshotId: "config-1",
        id: "attempt-1",
        model: "gpt-test",
        priceTableVersion: null,
        reasoningEffort: "medium",
        role: "implementation",
        routingReasons: ["classification.unknown", "route.implementation.standard"],
        workspacePath: "/tmp/work/ORG_repo_1",
      },
      claim: {
        expiresAt: "2026-07-13T10:02:00Z",
        holder: "run-1",
        originStage: "Todo",
      },
      reservation: { id: "reservation-1" },
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(result.dispatch.issueMutation).toEqual({
      authorization: result.authority.authorization,
      event: expect.objectContaining({
        attemptId: "attempt-1",
        eventName: "dispatch.pending",
        reasonCode: "dispatch.eligible",
        result: "pending",
        workRef: { issue_id: "issue-1" },
      }),
      intent: expect.objectContaining({
        action: "tracker.update_lane",
        attempt_id: "attempt-1",
        id: "intent-1",
        idempotency_key: "intent-1",
        target: "issue-1",
        target_revision: "revision-1",
      }),
    });
    expect(result.authority.expectation).toEqual({
      action: "tracker.update_lane",
      actorId: "orchestrator",
      actorKind: "orchestrator_policy",
      attemptRole: "implementation",
      configSnapshotId: "config-1",
      idempotencyKey: "intent-1",
      intentId: "intent-1",
      observedStateRef: "tracker:issue-1:revision-1",
      operatorCapability: null,
      scope: "work",
      serviceRunId: "run-1",
      target: "issue-1",
      targetRevision: "revision-1",
      workRef: "issue:issue-1",
    });
    expect(result.confirmedTransition).toEqual({
      attemptId: "attempt-1",
      expectedFromStage: "Todo",
      id: "stage-2",
      reason: "dispatch.eligible",
      timestampSource: "receipt",
      toStage: "In Progress",
      workRef: { id: "issue-1", kind: "issue" },
    });
  });

  it("rejects a stale lane, mismatched manifest route, and invalid time boundary", () => {
    const base = {
      attemptId: "attempt-1",
      attemptNumber: 1,
      authorizationId: "authorization-1",
      budgetLedgers: [{ amount: 100, id: "ledger", version: 1 }],
      changeClass: "standard" as const,
      classificationReasons: ["classification.unknown"],
      configSnapshotId: "config-1",
      eventId: "event-1",
      intentId: "intent-1",
      issue,
      leaseExpiresAt: "2026-07-13T10:02:00Z",
      manifest,
      now: "2026-07-13T10:00:00Z",
      providerRevision: "revision-1",
      reservationId: "reservation-1",
      route: {
        model: "gpt-test",
        profile: "standard" as const,
        reasoningEffort: "medium",
        reasons: ["route.implementation.standard"],
      },
      serviceRunId: "run-1",
      stageTransitionId: "stage-2",
      workspacePath: "/tmp/work/ORG_repo_1",
    };

    expect(() =>
      composeInitialIssueDispatch({ ...base, issue: { ...issue, state: "Review" } }),
    ).toThrow("dispatch.issue_not_todo");
    expect(() =>
      composeInitialIssueDispatch({
        ...base,
        route: { ...base.route, reasoningEffort: "high" },
      }),
    ).toThrow("dispatch.route_manifest_mismatch");
    expect(() =>
      composeInitialIssueDispatch({ ...base, leaseExpiresAt: "2026-07-13T09:59:00Z" }),
    ).toThrow("dispatch.lease_expiry_invalid");
  });
});
