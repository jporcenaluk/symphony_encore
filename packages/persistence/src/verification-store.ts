import { createHash } from "node:crypto";
import {
  type AgentVerification,
  type ImplementationOutcome,
  isImplementationOutcome,
  isSynthesisResult,
  type SynthesisResult,
} from "@symphony/contracts";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { transitionStageInTransaction } from "./stage-transition.js";

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
  return database
    .transaction()
    .execute((transaction) => recordVerificationInTransaction(transaction, input));
}

async function recordVerificationInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: RecordVerificationInput,
): Promise<RecordedVerification> {
  const stdoutBytes = Buffer.byteLength(input.execution.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(input.execution.stderr, "utf8");
  if (stdoutBytes + stderrBytes > MAXIMUM_EVIDENCE_BYTES) {
    throw new Error("verification.evidence_too_large");
  }
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
}

export async function recordVerificationAndRoute(
  database: Kysely<DatabaseSchema>,
  input: RecordVerificationInput & {
    expectedReadyReason: string;
    nextReadyReason: string;
  },
): Promise<RecordedVerification> {
  return database.transaction().execute(async (transaction) => {
    const recorded = await recordVerificationInTransaction(transaction, input);
    const claim = await sql`
      update claims
      set reason = ${input.nextReadyReason}, updated_at = ${input.execution.endedAt}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and mode = 'Ready'
        and reason = ${input.expectedReadyReason}
    `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("verification.claim_not_ready");
    return recorded;
  });
}

export async function recordSynthesisVerificationAndRoute(
  database: Kysely<DatabaseSchema>,
  input: RecordVerificationInput & {
    expectedReadyReason: "synthesis_verification_required";
    maxReworkCycles: number;
    transitionId: string;
    verifiedReadyReason?: "pull_request_hygiene_required" | "pull_request_required";
  },
): Promise<{ recorded: RecordedVerification; route: "human" | "pull_request" | "rework" }> {
  if (
    input.workRef.kind !== "system_job" ||
    !input.transitionId ||
    !Number.isSafeInteger(input.maxReworkCycles) ||
    input.maxReworkCycles < 1
  ) {
    throw new Error("verification.synthesis_route_input_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const priorFailures = await sql<{ count: number }>`
      select count(*) as count from verification_records
      where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
        and result != 'passed'
    `.execute(transaction);
    const recorded = await recordVerificationInTransaction(transaction, input);
    if (input.execution.result === "passed") {
      const claim = await sql`
        update claims set reason = ${input.verifiedReadyReason ?? "pull_request_required"},
          updated_at = ${input.execution.endedAt}
        where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
          and mode = 'Ready' and reason = ${input.expectedReadyReason}
      `.execute(transaction);
      if (claim.numAffectedRows !== 1n) throw new Error("verification.claim_not_ready");
      return { recorded, route: "pull_request" };
    }
    const exhausted = (priorFailures.rows[0]?.count ?? 0) + 1 >= input.maxReworkCycles;
    await transitionStageInTransaction(transaction, {
      attemptId: input.attemptId,
      confirmedExternalRevision: null,
      enteredAt: input.execution.endedAt,
      expectedFromStage: "review",
      id: input.transitionId,
      reason: exhausted ? "synthesis.verification_rework_limit" : "synthesis.verification_failed",
      timestampSource: "observed_estimate",
      toStage: exhausted ? "human" : "rework",
      workRef: input.workRef,
    });
    const job = await sql`
      update system_jobs set status = ${exhausted ? "human" : "rework"}
      where id = ${input.workRef.id} and kind = 'synthesis' and status = 'review'
    `.execute(transaction);
    if (job.numAffectedRows !== 1n) throw new Error("verification.synthesis_stage_mismatch");
    const claim = exhausted
      ? await sql`
          update claims set mode = 'AwaitingHuman', reason = 'human_review',
            updated_at = ${input.execution.endedAt}, expires_at = null,
            blocker_predicate = null, question_id = null, approval_request_id = null
          where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
            and mode = 'Ready' and reason = ${input.expectedReadyReason}
        `.execute(transaction)
      : await sql`
          update claims set reason = 'synthesis_rework', updated_at = ${input.execution.endedAt}
          where work_ref_kind = 'system_job' and work_ref_id = ${input.workRef.id}
            and mode = 'Ready' and reason = ${input.expectedReadyReason}
        `.execute(transaction);
    if (claim.numAffectedRows !== 1n) throw new Error("verification.claim_not_ready");
    return { recorded, route: exhausted ? "human" : "rework" };
  });
}

interface PendingVerificationRow {
  attempt_id: string;
  config_snapshot_id: string;
  payload_json: string;
  workspace_path: string;
}

export interface PendingIndependentVerification {
  attemptId: string;
  configSnapshotId: string;
  outcome: ImplementationOutcome & {
    status: "completed";
    verification: AgentVerification;
  };
  workspacePath: string;
}

export interface PendingSynthesisVerification {
  attemptId: string;
  configSnapshotId: string;
  result: Extract<SynthesisResult, { decision: "propose_changes" }>;
  workspacePath: string;
}

export async function loadPendingIndependentVerification(
  database: Kysely<DatabaseSchema>,
  workRef: WorkRef,
  expectedReadyReason = "independent_verification_required",
): Promise<PendingIndependentVerification | null> {
  if (
    expectedReadyReason !== "independent_verification_required" &&
    expectedReadyReason !== "independent_verification_after_base_update_required"
  ) {
    throw new Error("verification.ready_reason_invalid");
  }
  const query = await sql<PendingVerificationRow>`
    select attempt.id as attempt_id, attempt.config_snapshot_id,
           attempt.workspace_path, result.payload_json
    from claims claim
    join attempts attempt
      on attempt.work_ref_kind = claim.work_ref_kind
      and attempt.work_ref_id = claim.work_ref_id
      and attempt.role = 'implementation'
      and attempt.status = 'closed'
    join terminal_results result
      on result.id = attempt.terminal_result_id
      and result.attempt_id = attempt.id
      and result.role = 'implementation'
      and result.result_kind = 'implementation_outcome'
    where claim.work_ref_kind = ${workRef.kind}
      and claim.work_ref_id = ${workRef.id}
      and claim.mode = 'Ready'
      and claim.reason = ${expectedReadyReason}
    order by attempt.attempt_number desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  if (!row) return null;
  const outcome: unknown = JSON.parse(row.payload_json);
  if (
    !isImplementationOutcome(outcome) ||
    outcome.status !== "completed" ||
    !("verification" in outcome) ||
    outcome.verification.result !== "passed" ||
    outcome.verification.exit_code !== 0
  ) {
    throw new Error("verification.completed_outcome_invalid");
  }
  return {
    attemptId: row.attempt_id,
    configSnapshotId: row.config_snapshot_id,
    outcome: outcome as PendingIndependentVerification["outcome"],
    workspacePath: row.workspace_path,
  };
}

export async function loadPendingSynthesisVerification(
  database: Kysely<DatabaseSchema>,
  systemJobId: string,
): Promise<PendingSynthesisVerification | null> {
  const query = await sql<PendingVerificationRow>`
    select attempt.id as attempt_id, attempt.config_snapshot_id,
           attempt.workspace_path, result.payload_json
    from claims claim
    join attempts attempt
      on attempt.work_ref_kind = claim.work_ref_kind
      and attempt.work_ref_id = claim.work_ref_id
      and attempt.role = 'synthesis'
      and attempt.status = 'closed'
    join terminal_results result
      on result.id = attempt.terminal_result_id
      and result.attempt_id = attempt.id
      and result.role = 'synthesis'
      and result.result_kind = 'synthesis_result'
    join system_jobs job
      on job.id = claim.work_ref_id
      and job.kind = 'synthesis'
      and job.status = 'review'
    where claim.work_ref_kind = 'system_job'
      and claim.work_ref_id = ${systemJobId}
      and claim.mode = 'Ready'
      and claim.reason = 'synthesis_verification_required'
    order by attempt.attempt_number desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  if (!row) return null;
  const result: unknown = JSON.parse(row.payload_json);
  if (!isSynthesisResult(result) || result.decision !== "propose_changes") {
    throw new Error("verification.synthesis_result_invalid");
  }
  return {
    attemptId: row.attempt_id,
    configSnapshotId: row.config_snapshot_id,
    result,
    workspacePath: row.workspace_path,
  };
}

export async function loadLatestSynthesisProposal(
  database: Kysely<DatabaseSchema>,
  systemJobId: string,
): Promise<PendingSynthesisVerification | null> {
  const query = await sql<PendingVerificationRow>`
    select attempt.id as attempt_id, attempt.config_snapshot_id,
           attempt.workspace_path, result.payload_json
    from attempts attempt
    join terminal_results result
      on result.id = attempt.terminal_result_id
      and result.attempt_id = attempt.id
      and result.role = 'synthesis'
      and result.result_kind = 'synthesis_result'
    join system_jobs job
      on job.id = attempt.work_ref_id and job.kind = 'synthesis'
    where attempt.work_ref_kind = 'system_job'
      and attempt.work_ref_id = ${systemJobId}
      and attempt.role = 'synthesis'
      and attempt.status = 'closed'
    order by attempt.attempt_number desc
    limit 1
  `.execute(database);
  const row = query.rows[0];
  if (!row) return null;
  const result: unknown = JSON.parse(row.payload_json);
  if (!isSynthesisResult(result) || result.decision !== "propose_changes") {
    throw new Error("verification.synthesis_result_invalid");
  }
  return {
    attemptId: row.attempt_id,
    configSnapshotId: row.config_snapshot_id,
    result,
    workspacePath: row.workspace_path,
  };
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
