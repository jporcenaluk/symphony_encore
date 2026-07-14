import { createHash, timingSafeEqual } from "node:crypto";
import { type Kysely, sql } from "kysely";

import { inspectBootstrapEligibility } from "./bootstrap-store.js";
import type { ConfigurationSnapshot } from "./configuration-snapshot.js";
import { storeConfigurationSnapshot } from "./configuration-snapshot.js";
import type { DatabaseSchema } from "./database.js";

export const REQUIRED_OPERATOR_CAPABILITIES = [
  "agent.approve",
  "autonomy.write",
  "budget.write",
  "config.ack",
  "config.write",
  "merge_queue.write",
  "operator.read",
  "question.answer",
  "retention.write",
  "synthesis.write",
] as const;

export interface InitialBootstrapRequest {
  actionId: string;
  authSubject: string;
  candidateHash: string;
  confirmedCandidateHash: string;
  configSnapshot: ConfigurationSnapshot;
  consumedAt: string;
  credential: {
    algorithm: "scrypt";
    parameters: { N: number; keyLength: number; p: number; r: number };
    salt: Buffer;
    verifier: Buffer;
  };
  expectedBootstrapCredentialHash: string;
  operatorId: string;
  presentedBootstrapCredentialHash: string;
  trackerLogin: string | null;
}

export type InitialBootstrapResult =
  | { kind: "completed" }
  | { kind: "already_initialized" }
  | { kind: "nonpristine_operator_store_missing"; populatedTables: string[] }
  | { kind: "credential_mismatch" }
  | { kind: "candidate_mismatch" };

export async function completeInitialBootstrap(
  database: Kysely<DatabaseSchema>,
  request: InitialBootstrapRequest,
): Promise<InitialBootstrapResult> {
  return database.transaction().execute(async (transaction) => {
    const eligibility = await inspectBootstrapEligibility(transaction);
    if (eligibility.kind === "initialized") return { kind: "already_initialized" };
    if (eligibility.kind === "operator_store_missing_nonpristine") {
      return {
        kind: "nonpristine_operator_store_missing",
        populatedTables: eligibility.populatedTables,
      };
    }
    if (
      !constantTimeEqual(
        request.expectedBootstrapCredentialHash,
        request.presentedBootstrapCredentialHash,
      )
    ) {
      return { kind: "credential_mismatch" };
    }
    if (!constantTimeEqual(request.candidateHash, request.confirmedCandidateHash)) {
      return { kind: "candidate_mismatch" };
    }

    await storeConfigurationSnapshot(transaction, request.configSnapshot);
    await sql`
      insert into operators (
        id, auth_subject, capabilities_json, tracker_login, status, version,
        created_at, updated_at
      ) values (
        ${request.operatorId}, ${request.authSubject},
        ${JSON.stringify(REQUIRED_OPERATOR_CAPABILITIES)}, ${request.trackerLogin},
        'active', 1, ${request.consumedAt}, ${request.consumedAt}
      )
    `.execute(transaction);
    await sql`
      insert into local_operator_credentials (
        operator_id, algorithm, salt, verifier, parameters_json, created_at, rotated_at
      ) values (
        ${request.operatorId}, ${request.credential.algorithm}, ${request.credential.salt},
        ${request.credential.verifier}, ${JSON.stringify(request.credential.parameters)},
        ${request.consumedAt}, null
      )
    `.execute(transaction);
    await sql`
      insert into operator_actions (
        id, operator_id, auth_subject, capability, endpoint, action, target, reason,
        expected_version, observed_version, idempotency_key, request_payload_hash,
        result, created_at, expected_version_ref, observed_version_ref
      ) values (
        ${request.actionId}, ${request.operatorId}, ${request.authSubject},
        'bootstrap.local', '/bootstrap', 'bootstrap.complete', ${request.operatorId},
        'initial_administrator', 0, 0, ${request.candidateHash}, ${request.candidateHash},
        'accepted', ${request.consumedAt}, null, null
      )
    `.execute(transaction);
    const operatorConfiguration = [
      {
        auth_subject: request.authSubject,
        capabilities: [...REQUIRED_OPERATOR_CAPABILITIES],
        id: request.operatorId,
        ...(request.trackerLogin === null ? {} : { tracker_login: request.trackerLogin }),
      },
    ];
    await sql`
      insert into configuration_overrides (
        key, version, operation, value_json, created_by, created_at, reason,
        validation_result, acknowledgment_state, reload_state, operator_action_id
      ) values (
        'human.operators', 1, 'set', ${JSON.stringify(operatorConfiguration)},
        ${request.operatorId}, ${request.consumedAt}, 'initial_administrator',
        'valid', 'acknowledged', 'active', ${request.actionId}
      )
    `.execute(transaction);
    await sql`
      insert into bootstrap_state (
        singleton, candidate_hash, operator_id, config_snapshot_id,
        operator_action_id, consumed_at
      ) values (
        1, ${request.candidateHash}, ${request.operatorId}, ${request.configSnapshot.id},
        ${request.actionId}, ${request.consumedAt}
      )
    `.execute(transaction);
    return { kind: "completed" };
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
