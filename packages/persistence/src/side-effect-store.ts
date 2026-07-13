import type {
  MutationAuthorization,
  SideEffectIntent,
  SideEffectReceipt,
  WorkRef,
} from "@symphony/contracts";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface WorkRefColumns {
  id: string | null;
  kind: "issue" | "system_job" | null;
}

function workRefColumns(workRef: WorkRef | null): WorkRefColumns {
  if (workRef === null) return { id: null, kind: null };
  return "issue_id" in workRef
    ? { id: workRef.issue_id, kind: "issue" }
    : { id: workRef.system_job_id, kind: "system_job" };
}

function workRefsEqual(left: WorkRef | null, right: WorkRef | null): boolean {
  const leftColumns = workRefColumns(left);
  const rightColumns = workRefColumns(right);
  return leftColumns.kind === rightColumns.kind && leftColumns.id === rightColumns.id;
}

function assertExactEnvelope(authorization: MutationAuthorization, intent: SideEffectIntent): void {
  if (
    intent.status !== "pending" ||
    authorization.intent_id !== intent.id ||
    authorization.id !== intent.authorization_id ||
    authorization.idempotency_key !== intent.idempotency_key ||
    authorization.scope !== intent.scope ||
    !workRefsEqual(authorization.work_ref, intent.work_ref) ||
    authorization.service_run_id !== intent.service_run_id ||
    authorization.action !== intent.action ||
    authorization.target !== intent.target ||
    authorization.target_revision !== intent.target_revision
  ) {
    throw new Error("side_effect.authorization_mismatch");
  }
}

interface ExistingIntentRow {
  id: string;
  request_payload_hash: string;
}

export async function createAuthorizedIntent(
  database: Kysely<DatabaseSchema>,
  input: { authorization: MutationAuthorization; intent: SideEffectIntent },
): Promise<{ replayed: boolean }> {
  return database
    .transaction()
    .execute((transaction) => createAuthorizedIntentInTransaction(transaction, input));
}

export async function createAuthorizedIntentInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: { authorization: MutationAuthorization; intent: SideEffectIntent },
): Promise<{ replayed: boolean }> {
  assertExactEnvelope(input.authorization, input.intent);
  const existing = await sql<ExistingIntentRow>`
      select id, request_payload_hash
      from side_effect_intents
      where idempotency_key = ${input.intent.idempotency_key}
    `.execute(transaction);
  const original = existing.rows[0];
  if (original !== undefined) {
    if (original.request_payload_hash !== input.intent.request_payload_hash) {
      throw new Error("side_effect.idempotency_conflict");
    }
    return { replayed: true };
  }

  const authorizationWorkRef = workRefColumns(input.authorization.work_ref);
  await sql`
      insert into mutation_authorizations (
        id, intent_id, idempotency_key, scope, work_ref_kind, work_ref_id,
        service_run_id, actor_kind, actor_id, attempt_role, operator_capability,
        config_snapshot_id, action, target, observed_state_ref, target_revision,
        decision_rule_ids_json, authorized_at, expires_at
      ) values (
        ${input.authorization.id}, ${input.authorization.intent_id},
        ${input.authorization.idempotency_key}, ${input.authorization.scope},
        ${authorizationWorkRef.kind}, ${authorizationWorkRef.id},
        ${input.authorization.service_run_id}, ${input.authorization.actor_kind},
        ${input.authorization.actor_id}, ${input.authorization.attempt_role},
        ${input.authorization.operator_capability}, ${input.authorization.config_snapshot_id},
        ${input.authorization.action}, ${input.authorization.target},
        ${input.authorization.observed_state_ref}, ${input.authorization.target_revision},
        ${JSON.stringify(input.authorization.decision_rule_ids)},
        ${input.authorization.authorized_at}, ${input.authorization.expires_at}
      )
    `.execute(transaction);

  const intentWorkRef = workRefColumns(input.intent.work_ref);
  await sql`
      insert into side_effect_intents (
        id, idempotency_key, scope, work_ref_kind, work_ref_id, service_run_id,
        attempt_id, action, target, target_revision, request_payload_hash,
        authorization_id, status, created_at, updated_at
      ) values (
        ${input.intent.id}, ${input.intent.idempotency_key}, ${input.intent.scope},
        ${intentWorkRef.kind}, ${intentWorkRef.id}, ${input.intent.service_run_id},
        ${input.intent.attempt_id}, ${input.intent.action}, ${input.intent.target},
        ${input.intent.target_revision}, ${input.intent.request_payload_hash},
        ${input.intent.authorization_id}, 'pending', ${input.intent.created_at},
        ${input.intent.updated_at}
      )
    `.execute(transaction);
  return { replayed: false };
}

export async function markIntentApplying(
  database: Kysely<DatabaseSchema>,
  intentId: string,
  updatedAt: string,
): Promise<void> {
  const result = await sql`
    update side_effect_intents
    set status = 'applying', updated_at = ${updatedAt}
    where id = ${intentId} and status in ('pending', 'unknown')
  `.execute(database);
  if (result.numAffectedRows !== 1n) {
    throw new Error(`side_effect.not_applicable:${intentId}`);
  }
}

interface IntentRow {
  action: string;
  attempt_id: string | null;
  authorization_id: string;
  created_at: string;
  id: string;
  idempotency_key: string;
  request_payload_hash: string;
  scope: "work" | "fleet";
  service_run_id: string;
  status: "pending" | "applying" | "unknown";
  target: string;
  target_revision: string | null;
  updated_at: string;
  work_ref_id: string | null;
  work_ref_kind: "issue" | "system_job" | null;
}

function rowWorkRef(row: IntentRow): WorkRef | null {
  if (row.work_ref_kind === "issue" && row.work_ref_id !== null) {
    return { issue_id: row.work_ref_id };
  }
  if (row.work_ref_kind === "system_job" && row.work_ref_id !== null) {
    return { system_job_id: row.work_ref_id };
  }
  return null;
}

export async function loadUnreconciledIntents(
  database: Kysely<DatabaseSchema>,
): Promise<SideEffectIntent[]> {
  const result = await sql<IntentRow>`
    select intent.*
    from side_effect_intents intent
    left join side_effect_receipts receipt on receipt.intent_id = intent.id
    where receipt.intent_id is null and intent.status in ('pending', 'applying', 'unknown')
    order by intent.created_at, intent.id
  `.execute(database);
  return result.rows.map((row) => ({
    action: row.action,
    attempt_id: row.attempt_id,
    authorization_id: row.authorization_id,
    created_at: row.created_at,
    id: row.id,
    idempotency_key: row.idempotency_key,
    request_payload_hash: row.request_payload_hash,
    scope: row.scope,
    service_run_id: row.service_run_id,
    status: row.status,
    target: row.target,
    target_revision: row.target_revision,
    updated_at: row.updated_at,
    work_ref: rowWorkRef(row),
  })) as SideEffectIntent[];
}

interface ReceiptRow {
  applied_at: string;
  provider_request_id: string;
  response_payload_hash: string;
  result: string;
  result_revision: string | null;
}

export async function recordSideEffectReceipt(
  database: Kysely<DatabaseSchema>,
  receipt: SideEffectReceipt,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, receipt);
  });
}

export async function recordSideEffectReceiptInTransaction(
  transaction: Transaction<DatabaseSchema>,
  receipt: SideEffectReceipt,
): Promise<void> {
  const existing = await sql<ReceiptRow>`
      select provider_request_id, result, result_revision, response_payload_hash, applied_at
      from side_effect_receipts where intent_id = ${receipt.intent_id}
    `.execute(transaction);
  const original = existing.rows[0];
  if (original !== undefined) {
    if (
      JSON.stringify(original) !==
      JSON.stringify({
        applied_at: receipt.applied_at,
        provider_request_id: receipt.provider_request_id,
        response_payload_hash: receipt.response_payload_hash,
        result: receipt.result,
        result_revision: receipt.result_revision,
      })
    ) {
      throw new Error("side_effect.receipt_conflict");
    }
    return;
  }

  await sql`
      insert into side_effect_receipts (
        intent_id, provider_request_id, result, result_revision,
        response_payload_hash, applied_at
      ) values (
        ${receipt.intent_id}, ${receipt.provider_request_id}, ${receipt.result},
        ${receipt.result_revision}, ${receipt.response_payload_hash}, ${receipt.applied_at}
      )
    `.execute(transaction);
  const update = await sql`
      update side_effect_intents
      set status = 'applied', updated_at = ${receipt.applied_at}
      where id = ${receipt.intent_id} and status in ('pending', 'applying', 'unknown')
    `.execute(transaction);
  if (update.numAffectedRows !== 1n) {
    throw new Error(`side_effect.intent_not_reconcilable:${receipt.intent_id}`);
  }
}
