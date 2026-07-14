import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface StoredLocalCredential {
  algorithm: "scrypt";
  capabilities: string[];
  operatorId: string;
  operatorVersion: number;
  parameters: { N: number; keyLength: number; p: number; r: number };
  salt: Buffer;
  verifier: Buffer;
}

export interface AuthenticatedOperator {
  authSubject: string;
  capabilities: string[];
  csrfTokenHash: string;
  operatorId: string;
}

interface CredentialRow {
  algorithm: string;
  capabilities_json: string;
  operator_id: string;
  parameters_json: string;
  salt: Uint8Array;
  verifier: Uint8Array;
  version: number;
}

interface SessionRow {
  auth_subject: string;
  capabilities_json: string;
  csrf_token_hash: string;
  expires_at: string;
  operator_id: string;
  operator_status: string;
  operator_version: number;
  session_operator_version: number;
}

export async function createOperatorIdentity(
  database: Kysely<DatabaseSchema>,
  input: {
    authSubject: string;
    capabilities: string[];
    createdAt: string;
    credential: {
      algorithm: "scrypt";
      parameters: { N: number; keyLength: number; p: number; r: number };
      salt: Buffer;
      verifier: Buffer;
    };
    id: string;
    trackerLogin: string | null;
  },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      insert into operators (
        id, auth_subject, capabilities_json, tracker_login, status, version,
        created_at, updated_at
      ) values (
        ${input.id}, ${input.authSubject}, ${JSON.stringify(normalizeCapabilities(input.capabilities))},
        ${input.trackerLogin}, 'active', 1, ${input.createdAt}, ${input.createdAt}
      )
    `.execute(transaction);
    await sql`
      insert into local_operator_credentials (
        operator_id, algorithm, salt, verifier, parameters_json, created_at, rotated_at
      ) values (
        ${input.id}, ${input.credential.algorithm}, ${input.credential.salt},
        ${input.credential.verifier}, ${JSON.stringify(input.credential.parameters)},
        ${input.createdAt}, null
      )
    `.execute(transaction);
  });
}

export async function loadLocalCredentialBySubject(
  database: Kysely<DatabaseSchema>,
  authSubject: string,
): Promise<StoredLocalCredential | undefined> {
  const result = await sql<CredentialRow>`
    select
      credentials.algorithm,
      operators.capabilities_json,
      credentials.operator_id,
      credentials.parameters_json,
      credentials.salt,
      credentials.verifier,
      operators.version
    from local_operator_credentials credentials
    join operators on operators.id = credentials.operator_id
    where operators.auth_subject = ${authSubject} and operators.status = 'active'
  `.execute(database);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (row.algorithm !== "scrypt") throw new Error("auth.invalid_credential_algorithm");
  return {
    algorithm: "scrypt",
    capabilities: parseCapabilities(row.capabilities_json),
    operatorId: row.operator_id,
    operatorVersion: row.version,
    parameters: parseScryptParameters(row.parameters_json),
    salt: Buffer.from(row.salt),
    verifier: Buffer.from(row.verifier),
  };
}

export async function createOperatorSession(
  database: Kysely<DatabaseSchema>,
  input: {
    authSubject: string;
    csrfTokenHash: string;
    expiresAt: string;
    issuedAt: string;
    operatorId: string;
    operatorVersion: number;
    sessionTokenHash: string;
  },
): Promise<void> {
  await sql`
    insert into operator_sessions (
      token_hash, operator_id, auth_subject, csrf_token_hash, operator_version,
      issued_at, expires_at, last_seen_at, revoked_at
    ) values (
      ${input.sessionTokenHash}, ${input.operatorId}, ${input.authSubject},
      ${input.csrfTokenHash}, ${input.operatorVersion}, ${input.issuedAt},
      ${input.expiresAt}, ${input.issuedAt}, null
    )
  `.execute(database);
}

export async function authenticateOperatorSession(
  database: Kysely<DatabaseSchema>,
  input: { now: string; sessionTokenHash: string },
): Promise<AuthenticatedOperator | null> {
  return database.transaction().execute(async (transaction) => {
    const result = await sql<SessionRow>`
      select
        sessions.auth_subject,
        operators.capabilities_json,
        sessions.csrf_token_hash,
        sessions.expires_at,
        sessions.operator_id,
        operators.status as operator_status,
        operators.version as operator_version,
        sessions.operator_version as session_operator_version
      from operator_sessions sessions
      join operators on operators.id = sessions.operator_id
      where sessions.token_hash = ${input.sessionTokenHash}
        and sessions.revoked_at is null
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) return null;

    if (
      row.expires_at <= input.now ||
      row.operator_status !== "active" ||
      row.operator_version !== row.session_operator_version
    ) {
      await sql`
        update operator_sessions set revoked_at = ${input.now}
        where token_hash = ${input.sessionTokenHash} and revoked_at is null
      `.execute(transaction);
      return null;
    }

    await sql`
      update operator_sessions set last_seen_at = ${input.now}
      where token_hash = ${input.sessionTokenHash}
    `.execute(transaction);
    return {
      authSubject: row.auth_subject,
      capabilities: parseCapabilities(row.capabilities_json),
      csrfTokenHash: row.csrf_token_hash,
      operatorId: row.operator_id,
    };
  });
}

function normalizeCapabilities(capabilities: string[]): string[] {
  return [...new Set(capabilities)].sort();
}

function parseCapabilities(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("auth.invalid_capabilities");
  }
  return normalizeCapabilities(parsed);
}

function parseScryptParameters(value: string): {
  N: number;
  keyLength: number;
  p: number;
  r: number;
} {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) throw new Error("auth.invalid_verifier");
  const parameters = parsed as Record<string, unknown>;
  for (const key of ["N", "keyLength", "p", "r"] as const) {
    if (
      typeof parameters[key] !== "number" ||
      !Number.isSafeInteger(parameters[key]) ||
      parameters[key] <= 0
    ) {
      throw new Error("auth.invalid_verifier");
    }
  }
  return parameters as { N: number; keyLength: number; p: number; r: number };
}
