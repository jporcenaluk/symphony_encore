import type { MutationAuthorization, WorkRef } from "@symphony/contracts";
import {
  type AuthorizationActorKind,
  type AuthorizationDenialReason,
  type AuthorizationScope,
  type MutationAuthorizationEnvelope,
  type MutationRequestContext,
  validateMutationAuthorization,
} from "@symphony/domain";

export interface ProviderMutationExpectation {
  action: string;
  actorId: string;
  actorKind: AuthorizationActorKind;
  attemptRole: string | null;
  configSnapshotId: string;
  idempotencyKey: string;
  intentId: string;
  observedStateRef: string;
  operatorCapability: string | null;
  scope: AuthorizationScope;
  serviceRunId: string;
  target: string;
  targetRevision: string | null;
  workRef: string | null;
}

export interface ProviderMutationAuthority {
  authorization: MutationAuthorization | undefined;
  expectation: ProviderMutationExpectation;
}

export class ProviderAuthorizationError extends Error {
  readonly code: AuthorizationDenialReason;

  constructor(code: AuthorizationDenialReason) {
    super(code);
    this.name = "ProviderAuthorizationError";
    this.code = code;
  }
}

export function assertProviderMutationAuthorization(
  authorization: MutationAuthorization | undefined,
  expected: ProviderMutationExpectation,
  now: number = Date.now(),
): void {
  const request: MutationRequestContext = { ...expected };
  const decision = validateMutationAuthorization(
    authorization === undefined ? undefined : toDomainAuthorization(authorization),
    request,
    now,
  );
  if (!decision.allow) throw new ProviderAuthorizationError(decision.reason);
}

function toDomainAuthorization(
  authorization: MutationAuthorization,
): MutationAuthorizationEnvelope {
  return {
    action: authorization.action,
    actorId: authorization.actor_id,
    actorKind: authorization.actor_kind,
    attemptRole: authorization.attempt_role,
    authorizedAt: authorization.authorized_at,
    configSnapshotId: authorization.config_snapshot_id,
    expiresAt: authorization.expires_at,
    id: authorization.id,
    idempotencyKey: authorization.idempotency_key,
    intentId: authorization.intent_id,
    observedStateRef: authorization.observed_state_ref,
    operatorCapability: authorization.operator_capability,
    scope: authorization.scope,
    serviceRunId: authorization.service_run_id,
    target: authorization.target,
    targetRevision: authorization.target_revision,
    workRef: authorization.work_ref === null ? null : formatWorkRef(authorization.work_ref),
  };
}

export function formatWorkRef(workRef: WorkRef): string {
  return "issue_id" in workRef
    ? `issue:${workRef.issue_id}`
    : `system_job:${workRef.system_job_id}`;
}
