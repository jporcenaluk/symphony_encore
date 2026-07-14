import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface ConfigurationOverrideMutation {
  actionId: string;
  authSubject: string;
  capability: string;
  createdAt: string;
  endpoint: string;
  expectedVersion: number;
  idempotencyKey: string;
  key: string;
  operation: "set" | "clear";
  operatorId: string;
  reason: string;
  requestPayloadHash: string;
  validationError: string | null;
  value: unknown;
}

export type ConfigurationOverrideMutationResult = {
  result: "accepted" | "idempotency_conflict" | "version_conflict" | "validation_failed";
  version: number;
};

export interface ActiveConfigurationOverride {
  key: string;
  value: unknown;
  version: number;
}

interface IdempotencyRow {
  request_payload_hash: string;
  response_json: string;
}

interface VersionRow {
  version: number;
}

interface ActiveOverrideRow {
  key: string;
  value_json: string;
  version: number;
}

async function insertOperatorAction(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationOverrideMutation,
  observedVersion: number,
  result: ConfigurationOverrideMutationResult["result"],
): Promise<void> {
  await sql`
    insert into operator_actions (
      id, operator_id, auth_subject, capability, endpoint, action, target, reason,
      expected_version, observed_version, idempotency_key, request_payload_hash,
      result, created_at
    ) values (
      ${request.actionId}, ${request.operatorId}, ${request.authSubject}, ${request.capability},
      ${request.endpoint}, ${`configuration_override.${request.operation}`}, ${request.key},
      ${request.reason}, ${request.expectedVersion}, ${observedVersion},
      ${request.idempotencyKey}, ${request.requestPayloadHash}, ${result}, ${request.createdAt}
    )
  `.execute(database);
}

async function bindIdempotencyKey(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationOverrideMutation,
  response: ConfigurationOverrideMutationResult,
): Promise<void> {
  await sql`
    insert into operator_idempotency_keys (
      operator_id, endpoint, target, idempotency_key, request_payload_hash,
      original_action_id, response_json
    ) values (
      ${request.operatorId}, ${request.endpoint}, ${request.key}, ${request.idempotencyKey},
      ${request.requestPayloadHash}, ${request.actionId}, ${JSON.stringify(response)}
    )
  `.execute(database);
}

export async function mutateConfigurationOverride(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationOverrideMutation,
): Promise<ConfigurationOverrideMutationResult> {
  return database.transaction().execute(async (transaction) => {
    const existingKey = await sql<IdempotencyRow>`
      select request_payload_hash, response_json
      from operator_idempotency_keys
      where operator_id = ${request.operatorId}
        and endpoint = ${request.endpoint}
        and target = ${request.key}
        and idempotency_key = ${request.idempotencyKey}
    `.execute(transaction);
    const existing = existingKey.rows[0];
    const currentRows = await sql<VersionRow>`
      select coalesce(max(version), 0) as version
      from configuration_overrides
      where key = ${request.key}
    `.execute(transaction);
    const currentVersion = currentRows.rows[0]?.version ?? 0;

    if (existing) {
      if (existing.request_payload_hash === request.requestPayloadHash) {
        return JSON.parse(existing.response_json) as ConfigurationOverrideMutationResult;
      }
      const response: ConfigurationOverrideMutationResult = {
        result: "idempotency_conflict",
        version: currentVersion,
      };
      await insertOperatorAction(transaction, request, currentVersion, response.result);
      return response;
    }

    if (request.expectedVersion !== currentVersion) {
      const response: ConfigurationOverrideMutationResult = {
        result: "version_conflict",
        version: currentVersion,
      };
      await insertOperatorAction(transaction, request, currentVersion, response.result);
      await bindIdempotencyKey(transaction, request, response);
      return response;
    }

    if (request.validationError !== null) {
      const response: ConfigurationOverrideMutationResult = {
        result: "validation_failed",
        version: currentVersion,
      };
      await insertOperatorAction(transaction, request, currentVersion, response.result);
      await bindIdempotencyKey(transaction, request, response);
      return response;
    }

    const nextVersion = currentVersion + 1;
    const response: ConfigurationOverrideMutationResult = {
      result: "accepted",
      version: nextVersion,
    };
    await insertOperatorAction(transaction, request, currentVersion, response.result);
    await sql`
      insert into configuration_overrides (
        key, version, operation, value_json, created_by, created_at, reason,
        validation_result, acknowledgment_state, reload_state, operator_action_id
      ) values (
        ${request.key}, ${nextVersion}, ${request.operation},
        ${request.operation === "set" ? JSON.stringify(request.value) : null},
        ${request.operatorId}, ${request.createdAt}, ${request.reason}, 'valid',
        'pending_evaluation', 'pending_evaluation', ${request.actionId}
      )
    `.execute(transaction);
    await bindIdempotencyKey(transaction, request, response);
    return response;
  });
}

export async function loadActiveOverrides(
  database: Kysely<DatabaseSchema>,
): Promise<ActiveConfigurationOverride[]> {
  const result = await sql<ActiveOverrideRow>`
    select override.key, override.version, override.value_json
    from configuration_overrides as override
    join (
      select key, max(version) as version
      from configuration_overrides
      group by key
    ) as latest on latest.key = override.key and latest.version = override.version
    where override.operation = 'set'
    order by override.key
  `.execute(database);
  return result.rows.map((row) => ({
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    version: row.version,
  }));
}
