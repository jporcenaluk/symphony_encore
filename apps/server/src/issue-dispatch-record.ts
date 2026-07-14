import { createHash } from "node:crypto";
import path from "node:path";

import type { ProviderMutationAuthority } from "@symphony/adapters";
import type { AgentAdapterManifest, Issue, MutationAuthorization } from "@symphony/contracts";
import type { ChangeClass, ComputeRoute } from "@symphony/domain";
import type {
  DispatchBudgetReservationLedger,
  DispatchInput,
  StageTransitionInput,
} from "@symphony/persistence";

export interface InitialIssueDispatchInput {
  attemptId: string;
  attemptNumber: number;
  authorizationId: string;
  budgetLedgers: readonly DispatchBudgetReservationLedger[];
  changeClass: ChangeClass;
  classificationReasons: readonly string[];
  configSnapshotId: string;
  eventId: string;
  intentId: string;
  issue: Issue;
  leaseExpiresAt: string;
  manifest: AgentAdapterManifest;
  now: string;
  providerRevision: string;
  reservationId: string;
  route: ComputeRoute;
  serviceRunId: string;
  stageTransitionId: string;
  workspacePath: string;
}

export interface InitialIssueDispatch {
  authority: ProviderMutationAuthority;
  confirmedTransition: Omit<StageTransitionInput, "confirmedExternalRevision" | "enteredAt">;
  dispatch: DispatchInput;
}

export function composeInitialIssueDispatch(
  input: InitialIssueDispatchInput,
): InitialIssueDispatch {
  validateInput(input);
  const workRef = { issue_id: input.issue.id } as const;
  const observedStateRef = `tracker:${input.issue.id}:${input.providerRevision}`;
  const routingReasons = [...new Set([...input.classificationReasons, ...input.route.reasons])];
  const authorization: MutationAuthorization = {
    action: "tracker.update_lane",
    actor_id: "orchestrator",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: input.now,
    config_snapshot_id: input.configSnapshotId,
    decision_rule_ids: ["dispatch.eligible", "lane.todo_to_in_progress", ...routingReasons],
    expires_at: input.leaseExpiresAt,
    id: input.authorizationId,
    idempotency_key: input.intentId,
    intent_id: input.intentId,
    observed_state_ref: observedStateRef,
    operator_capability: null,
    scope: "work",
    service_run_id: input.serviceRunId,
    target: input.issue.id,
    target_revision: input.providerRevision,
    work_ref: workRef,
  };
  const authority: ProviderMutationAuthority = {
    authorization,
    expectation: {
      action: authorization.action,
      actorId: authorization.actor_id,
      actorKind: authorization.actor_kind,
      attemptRole: authorization.attempt_role,
      configSnapshotId: authorization.config_snapshot_id,
      idempotencyKey: authorization.idempotency_key,
      intentId: authorization.intent_id,
      observedStateRef: authorization.observed_state_ref,
      operatorCapability: authorization.operator_capability,
      scope: authorization.scope,
      serviceRunId: authorization.service_run_id,
      target: authorization.target,
      targetRevision: authorization.target_revision,
      workRef: `issue:${input.issue.id}`,
    },
  };
  const dispatch: DispatchInput = {
    attempt: {
      attemptNumber: input.attemptNumber,
      changeClass: input.changeClass,
      computeProfile: input.route.profile,
      configSnapshotId: input.configSnapshotId,
      costUsd: null,
      id: input.attemptId,
      model: input.route.model,
      priceTableVersion: input.manifest.price_table?.version ?? null,
      reasoningEffort: input.route.reasoningEffort,
      role: "implementation",
      routingReasons,
      startedAt: input.now,
      workspacePath: input.workspacePath,
    },
    claim: {
      acquiredAt: input.now,
      expiresAt: input.leaseExpiresAt,
      holder: input.serviceRunId,
      originStage: "Todo",
      reason: "dispatch.eligible",
    },
    issueMutation: {
      authorization,
      event: {
        attemptId: input.attemptId,
        changeClass: input.changeClass,
        computeProfile: input.route.profile,
        costUsd: null,
        eventName: "dispatch.pending",
        id: input.eventId,
        payload: {
          adapter_version: input.manifest.adapter_version,
          model: input.route.model,
          reasoning_effort: input.route.reasoningEffort,
          target_lane: "In Progress",
        },
        reasonCode: "dispatch.eligible",
        result: "pending",
        serviceRunId: input.serviceRunId,
        timestamp: input.now,
        workRef,
      },
      intent: {
        action: authorization.action,
        attempt_id: input.attemptId,
        authorization_id: authorization.id,
        created_at: input.now,
        id: input.intentId,
        idempotency_key: input.intentId,
        request_payload_hash: sha256({
          from_lane: "Todo",
          issue_id: input.issue.id,
          reason: "dispatch.eligible",
          to_lane: "In Progress",
        }),
        scope: "work",
        service_run_id: input.serviceRunId,
        status: "pending",
        target: input.issue.id,
        target_revision: input.providerRevision,
        updated_at: input.now,
        work_ref: workRef,
      },
    },
    reservation: {
      id: input.reservationId,
      ledgers: input.budgetLedgers.map((ledger) => ({ ...ledger })),
    },
    workRef: { id: input.issue.id, kind: "issue" },
  };
  return {
    authority,
    confirmedTransition: {
      attemptId: input.attemptId,
      expectedFromStage: "Todo",
      id: input.stageTransitionId,
      reason: "dispatch.eligible",
      timestampSource: "receipt",
      toStage: "In Progress",
      workRef: { id: input.issue.id, kind: "issue" },
    },
    dispatch,
  };
}

function validateInput(input: InitialIssueDispatchInput): void {
  if (input.issue.state !== "Todo") throw new Error("dispatch.issue_not_todo");
  const selected = input.manifest.profiles[input.route.profile];
  if (
    selected.model !== input.route.model ||
    selected.reasoning_effort !== input.route.reasoningEffort
  ) {
    throw new Error("dispatch.route_manifest_mismatch");
  }
  if (
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    input.budgetLedgers.length === 0 ||
    input.budgetLedgers.some(
      (ledger) =>
        !ledger.id ||
        !Number.isFinite(ledger.amount) ||
        ledger.amount < 0 ||
        !Number.isSafeInteger(ledger.version) ||
        ledger.version < 1,
    )
  ) {
    throw new Error("dispatch.reservation_invalid");
  }
  const now = Date.parse(input.now);
  const expiresAt = Date.parse(input.leaseExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("dispatch.lease_expiry_invalid");
  }
  if (!path.isAbsolute(input.workspacePath)) throw new Error("dispatch.workspace_path_invalid");
  for (const value of [
    input.attemptId,
    input.authorizationId,
    input.configSnapshotId,
    input.eventId,
    input.intentId,
    input.providerRevision,
    input.reservationId,
    input.serviceRunId,
    input.stageTransitionId,
    ...input.classificationReasons,
    ...input.route.reasons,
  ]) {
    if (!value) throw new Error("dispatch.identity_invalid");
  }
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
}
