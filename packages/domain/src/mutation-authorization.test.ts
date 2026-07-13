import { describe, expect, it } from "vitest";

import { validateMutationAuthorization } from "./mutation-authorization.js";

const authorization = {
  action: "update_issue_lane",
  actorId: "orchestrator",
  actorKind: "orchestrator_policy" as const,
  attemptRole: "implementation",
  authorizedAt: "2026-07-13T10:00:00Z",
  configSnapshotId: "config-1",
  expiresAt: "2026-07-13T10:05:00Z",
  id: "auth-1",
  idempotencyKey: "issue-1:attempt-1:update:rev-1",
  intentId: "intent-1",
  observedStateRef: "tracker-snapshot-1",
  operatorCapability: null,
  scope: "work" as const,
  serviceRunId: "service-run-1",
  target: "issue-1",
  targetRevision: "rev-1",
  workRef: "issue:issue-1",
};

const request = {
  action: authorization.action,
  actorId: authorization.actorId,
  actorKind: authorization.actorKind,
  attemptRole: authorization.attemptRole,
  configSnapshotId: authorization.configSnapshotId,
  idempotencyKey: authorization.idempotencyKey,
  intentId: authorization.intentId,
  observedStateRef: authorization.observedStateRef,
  operatorCapability: authorization.operatorCapability,
  scope: authorization.scope,
  serviceRunId: authorization.serviceRunId,
  target: authorization.target,
  targetRevision: authorization.targetRevision,
  workRef: authorization.workRef,
};

describe("mutation authorization", () => {
  it("allows only the exact persisted envelope before expiry", () => {
    expect(
      validateMutationAuthorization(authorization, request, Date.parse("2026-07-13T10:04:00Z")),
    ).toEqual({ allow: true });
  });

  it.each([
    ["actorId", "different", "authorization.actor_mismatch"],
    ["configSnapshotId", "config-2", "authorization.config_mismatch"],
    ["observedStateRef", "tracker-snapshot-2", "authorization.observed_state_mismatch"],
    ["targetRevision", "rev-2", "authorization.revision_mismatch"],
    ["target", "issue-2", "authorization.target_mismatch"],
    ["intentId", "intent-2", "authorization.intent_mismatch"],
  ] as const)("rejects a mismatched %s", (field, value, reason) => {
    expect(
      validateMutationAuthorization(
        authorization,
        { ...request, [field]: value },
        Date.parse("2026-07-13T10:04:00Z"),
      ),
    ).toEqual({ allow: false, reason });
  });

  it("rejects missing and expired envelopes", () => {
    expect(
      validateMutationAuthorization(undefined, request, Date.parse("2026-07-13T10:04:00Z")),
    ).toEqual({ allow: false, reason: "authorization.missing" });
    expect(
      validateMutationAuthorization(authorization, request, Date.parse("2026-07-13T10:05:01Z")),
    ).toEqual({ allow: false, reason: "authorization.expired" });
  });

  it("allows fleet notifications only without a work reference", () => {
    const fleetAuthorization = {
      ...authorization,
      action: "notify_fleet_budget",
      scope: "fleet" as const,
      target: "fleet",
      targetRevision: null,
      workRef: null,
    };
    const fleetRequest = {
      ...request,
      action: "notify_fleet_budget",
      scope: "fleet" as const,
      target: "fleet",
      targetRevision: null,
      workRef: null,
    };
    expect(
      validateMutationAuthorization(
        fleetAuthorization,
        fleetRequest,
        Date.parse("2026-07-13T10:04:00Z"),
      ),
    ).toEqual({ allow: true });
    expect(
      validateMutationAuthorization(
        fleetAuthorization,
        { ...fleetRequest, workRef: "issue:issue-1" },
        Date.parse("2026-07-13T10:04:00Z"),
      ),
    ).toEqual({ allow: false, reason: "authorization.scope_mismatch" });
  });
});
