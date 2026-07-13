import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface ConfigurationAcknowledgmentRequest {
  actionId: string;
  authSubject: string;
  candidateHash: string;
  candidateVersion: string;
  capability: string;
  createdAt: string;
  endpoint: string;
  expectedCandidateVersion: string;
  id: string;
  idempotencyKey: string;
  key: string;
  observedCandidateVersion: string;
  operatorId: string;
  reason: string;
  requestPayloadHash: string;
}

export type ConfigurationAcknowledgmentResult = {
  result: "accepted" | "idempotency_conflict" | "version_conflict";
};

interface IdempotencyRow {
  request_payload_hash: string;
  response_json: string;
}

interface ExistingAcknowledgmentRow {
  candidate_hash: string;
}

async function auditAcknowledgment(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationAcknowledgmentRequest,
  result: ConfigurationAcknowledgmentResult["result"],
): Promise<void> {
  await sql`
    insert into operator_actions (
      id, operator_id, auth_subject, capability, endpoint, action, target, reason,
      expected_version, observed_version, idempotency_key, request_payload_hash,
      result, created_at, expected_version_ref, observed_version_ref
    ) values (
      ${request.actionId}, ${request.operatorId}, ${request.authSubject}, ${request.capability},
      ${request.endpoint}, 'configuration.acknowledge', ${request.key}, ${request.reason},
      0, 0, ${request.idempotencyKey}, ${request.requestPayloadHash}, ${result},
      ${request.createdAt}, ${request.expectedCandidateVersion}, ${request.observedCandidateVersion}
    )
  `.execute(database);
}

async function bindAcknowledgmentIdempotency(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationAcknowledgmentRequest,
  response: ConfigurationAcknowledgmentResult,
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

export async function acknowledgeConfigurationCandidate(
  database: Kysely<DatabaseSchema>,
  request: ConfigurationAcknowledgmentRequest,
): Promise<ConfigurationAcknowledgmentResult> {
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
    if (existing) {
      if (existing.request_payload_hash === request.requestPayloadHash) {
        return JSON.parse(existing.response_json) as ConfigurationAcknowledgmentResult;
      }
      const response: ConfigurationAcknowledgmentResult = { result: "idempotency_conflict" };
      await auditAcknowledgment(transaction, request, response.result);
      return response;
    }

    if (
      request.expectedCandidateVersion !== request.observedCandidateVersion ||
      request.candidateVersion !== request.observedCandidateVersion
    ) {
      const response: ConfigurationAcknowledgmentResult = { result: "version_conflict" };
      await auditAcknowledgment(transaction, request, response.result);
      await bindAcknowledgmentIdempotency(transaction, request, response);
      return response;
    }

    const response: ConfigurationAcknowledgmentResult = { result: "accepted" };
    await auditAcknowledgment(transaction, request, response.result);
    const alreadyAcknowledged = await sql<ExistingAcknowledgmentRow>`
      select candidate_hash from configuration_acknowledgments
      where candidate_hash = ${request.candidateHash}
    `.execute(transaction);
    if (alreadyAcknowledged.rows.length === 0) {
      await sql`
        insert into configuration_acknowledgments (
          id, key, candidate_hash, candidate_version, acknowledged_by,
          acknowledged_at, operator_action_id
        ) values (
          ${request.id}, ${request.key}, ${request.candidateHash}, ${request.candidateVersion},
          ${request.operatorId}, ${request.createdAt}, ${request.actionId}
        )
      `.execute(transaction);
    }
    await bindAcknowledgmentIdempotency(transaction, request, response);
    return response;
  });
}

export async function loadAcknowledgedCandidateHashes(
  database: Kysely<DatabaseSchema>,
): Promise<Set<string>> {
  const result = await sql<{ candidate_hash: string }>`
    select candidate_hash from configuration_acknowledgments order by candidate_hash
  `.execute(database);
  return new Set(result.rows.map((row) => row.candidate_hash));
}
