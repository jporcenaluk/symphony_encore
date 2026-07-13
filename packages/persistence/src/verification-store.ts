import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

type WorkRef = { id: string; kind: "issue" | "system_job" };

export interface VerificationExecution {
  commandHash: string;
  endedAt: string;
  environmentPolicyHash: string;
  exitCode: number;
  result: "passed" | "failed" | "error";
  startedAt: string;
  stderr: string;
  stdout: string;
}

export interface RecordVerificationInput {
  attemptId: string;
  configSnapshotId: string;
  execution: VerificationExecution;
  id: string;
  targetRevision: string;
  workRef: WorkRef;
}

export interface RecordedVerification {
  id: string;
  result: VerificationExecution["result"];
  stderrRef: string | null;
  stdoutRef: string | null;
}

const MAXIMUM_EVIDENCE_BYTES = 1_048_576;

function evidenceId(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function storeEvidence(
  database: Kysely<DatabaseSchema>,
  content: string,
  createdAt: string,
): Promise<string | null> {
  if (content.length === 0) return null;
  const bytes = Buffer.from(content, "utf8");
  const id = evidenceId(bytes);
  await sql`
    insert into evidence_blobs (id, media_type, byte_length, content, created_at)
    values (${id}, 'text/plain; charset=utf-8', ${bytes.byteLength}, ${bytes}, ${createdAt})
    on conflict (id) do nothing
  `.execute(database);
  return id;
}

export async function recordVerification(
  database: Kysely<DatabaseSchema>,
  input: RecordVerificationInput,
): Promise<RecordedVerification> {
  const stdoutBytes = Buffer.byteLength(input.execution.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(input.execution.stderr, "utf8");
  if (stdoutBytes + stderrBytes > MAXIMUM_EVIDENCE_BYTES) {
    throw new Error("verification.evidence_too_large");
  }
  return database.transaction().execute(async (transaction) => {
    const stdoutRef = await storeEvidence(
      transaction,
      input.execution.stdout,
      input.execution.endedAt,
    );
    const stderrRef = await storeEvidence(
      transaction,
      input.execution.stderr,
      input.execution.endedAt,
    );
    await sql`
      insert into verification_records (
        id, work_ref_kind, work_ref_id, attempt_id, config_snapshot_id,
        target_revision, command_hash, started_at, ended_at, exit_code,
        result, stdout_ref, stderr_ref, environment_policy_hash
      ) values (
        ${input.id}, ${input.workRef.kind}, ${input.workRef.id}, ${input.attemptId},
        ${input.configSnapshotId}, ${input.targetRevision}, ${input.execution.commandHash},
        ${input.execution.startedAt}, ${input.execution.endedAt}, ${input.execution.exitCode},
        ${input.execution.result}, ${stdoutRef}, ${stderrRef},
        ${input.execution.environmentPolicyHash}
      )
    `.execute(transaction);
    return { id: input.id, result: input.execution.result, stderrRef, stdoutRef };
  });
}

export interface PassingVerificationQuery {
  commandHash: string;
  configSnapshotId: string;
  environmentPolicyHash: string;
  targetRevision: string;
  workRef: WorkRef;
}

interface VerificationRow {
  id: string;
  result: "passed";
  stderr_ref: string | null;
  stdout_ref: string | null;
}

export async function findPassingVerification(
  database: Kysely<DatabaseSchema>,
  query: PassingVerificationQuery,
): Promise<RecordedVerification | undefined> {
  const result = await sql<VerificationRow>`
    select id, result, stdout_ref, stderr_ref
    from verification_records
    where work_ref_kind = ${query.workRef.kind}
      and work_ref_id = ${query.workRef.id}
      and target_revision = ${query.targetRevision}
      and config_snapshot_id = ${query.configSnapshotId}
      and command_hash = ${query.commandHash}
      and environment_policy_hash = ${query.environmentPolicyHash}
      and result = 'passed'
    order by ended_at desc, id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        result: row.result,
        stderrRef: row.stderr_ref,
        stdoutRef: row.stdout_ref,
      };
}

interface EvidenceRow {
  content: Buffer;
  media_type: string;
}

export async function loadVerificationEvidence(
  database: Kysely<DatabaseSchema>,
  id: string,
): Promise<{ content: string; mediaType: string } | undefined> {
  const result = await sql<EvidenceRow>`
    select content, media_type from evidence_blobs where id = ${id}
  `.execute(database);
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { content: row.content.toString("utf8"), mediaType: row.media_type };
}
