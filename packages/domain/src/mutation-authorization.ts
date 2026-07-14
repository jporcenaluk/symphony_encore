export type AuthorizationScope = "work" | "fleet";
export type AuthorizationActorKind = "orchestrator_policy" | "operator";

export interface MutationAuthorizationEnvelope {
  action: string;
  actorId: string;
  actorKind: AuthorizationActorKind;
  attemptRole: string | null;
  authorizedAt: string;
  configSnapshotId: string;
  expiresAt: string;
  id: string;
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

export type MutationRequestContext = Omit<
  MutationAuthorizationEnvelope,
  "authorizedAt" | "expiresAt" | "id"
>;

export type AuthorizationDenialReason =
  | "authorization.missing"
  | "authorization.expired"
  | "authorization.scope_mismatch"
  | "authorization.actor_mismatch"
  | "authorization.action_mismatch"
  | "authorization.config_mismatch"
  | "authorization.observed_state_mismatch"
  | "authorization.revision_mismatch"
  | "authorization.target_mismatch"
  | "authorization.intent_mismatch"
  | "authorization.idempotency_mismatch"
  | "authorization.service_run_mismatch";

export type AuthorizationDecision =
  | { allow: true }
  | { allow: false; reason: AuthorizationDenialReason };

function scopeIsValid(scope: AuthorizationScope, workRef: string | null): boolean {
  return scope === "work" ? workRef !== null : workRef === null;
}

export function validateMutationAuthorization(
  authorization: MutationAuthorizationEnvelope | undefined,
  request: MutationRequestContext,
  now: number,
): AuthorizationDecision {
  if (!authorization) return { allow: false, reason: "authorization.missing" };
  if (Date.parse(authorization.expiresAt) < now) {
    return { allow: false, reason: "authorization.expired" };
  }
  if (
    authorization.scope !== request.scope ||
    authorization.workRef !== request.workRef ||
    !scopeIsValid(authorization.scope, authorization.workRef) ||
    !scopeIsValid(request.scope, request.workRef)
  ) {
    return { allow: false, reason: "authorization.scope_mismatch" };
  }
  if (
    authorization.actorId !== request.actorId ||
    authorization.actorKind !== request.actorKind ||
    authorization.attemptRole !== request.attemptRole ||
    authorization.operatorCapability !== request.operatorCapability
  ) {
    return { allow: false, reason: "authorization.actor_mismatch" };
  }
  if (authorization.action !== request.action) {
    return { allow: false, reason: "authorization.action_mismatch" };
  }
  if (authorization.configSnapshotId !== request.configSnapshotId) {
    return { allow: false, reason: "authorization.config_mismatch" };
  }
  if (authorization.observedStateRef !== request.observedStateRef) {
    return { allow: false, reason: "authorization.observed_state_mismatch" };
  }
  if (authorization.targetRevision !== request.targetRevision) {
    return { allow: false, reason: "authorization.revision_mismatch" };
  }
  if (authorization.target !== request.target) {
    return { allow: false, reason: "authorization.target_mismatch" };
  }
  if (authorization.intentId !== request.intentId) {
    return { allow: false, reason: "authorization.intent_mismatch" };
  }
  if (authorization.idempotencyKey !== request.idempotencyKey) {
    return { allow: false, reason: "authorization.idempotency_mismatch" };
  }
  if (authorization.serviceRunId !== request.serviceRunId) {
    return { allow: false, reason: "authorization.service_run_mismatch" };
  }
  return { allow: true };
}
