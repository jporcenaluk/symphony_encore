import type { MutationAuthorization } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import {
  assertProviderMutationAuthorization,
  type ProviderAuthorizationError,
  type ProviderMutationExpectation,
} from "./provider-authorization.js";

const expected: ProviderMutationExpectation = {
  action: "tracker.update_lane",
  actorId: "orchestrator",
  actorKind: "orchestrator_policy",
  attemptRole: "implementation",
  configSnapshotId: "config-1",
  idempotencyKey: "intent-1",
  intentId: "intent-1",
  observedStateRef: "tracker:issue-1:revision-4",
  operatorCapability: null,
  scope: "work",
  serviceRunId: "run-1",
  target: "issue-1",
  targetRevision: "revision-4",
  workRef: "issue:issue-1",
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
  observed_state_ref: "tracker:issue-1:revision-4",
  operator_capability: null,
  scope: "work",
  service_run_id: "run-1",
  target: "issue-1",
  target_revision: "revision-4",
  work_ref: { issue_id: "issue-1" },
};

describe("provider mutation authorization", () => {
  it("accepts only the exact unexpired durable envelope", () => {
    expect(() =>
      assertProviderMutationAuthorization(
        authorization,
        expected,
        Date.parse("2026-07-13T10:01:00Z"),
      ),
    ).not.toThrow();
  });

  it.each([
    [undefined, "authorization.missing"],
    [{ ...authorization, expires_at: "2026-07-13T09:59:00Z" }, "authorization.expired"],
    [{ ...authorization, config_snapshot_id: "config-stale" }, "authorization.config_mismatch"],
    [
      { ...authorization, observed_state_ref: "tracker:issue-1:revision-3" },
      "authorization.observed_state_mismatch",
    ],
    [{ ...authorization, target_revision: "revision-3" }, "authorization.revision_mismatch"],
    [{ ...authorization, target: "issue-2" }, "authorization.target_mismatch"],
  ] as const)("rejects a missing or mismatched envelope", (candidate, code) => {
    expect(() =>
      assertProviderMutationAuthorization(candidate, expected, Date.parse("2026-07-13T10:01:00Z")),
    ).toThrow(expect.objectContaining<Partial<ProviderAuthorizationError>>({ code }));
  });
});
