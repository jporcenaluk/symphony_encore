import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

type TimestampSource = "receipt" | "tracker" | "observed_estimate";
type WorkRef = { id: string; kind: "issue" | "system_job" };

export interface BaselineStageInput {
  enteredAt: string;
  id: string;
  reason: string;
  timestampSource: TimestampSource;
  toStage: string;
  workRef: WorkRef;
}

export interface StageTransitionInput extends BaselineStageInput {
  attemptId: string | null;
  confirmedExternalRevision: string | null;
  expectedFromStage: string;
}

function durationBetween(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`Invalid stage transition time range ${start} to ${end}`);
  }
  return duration;
}

export async function openBaselineStage(
  database: Kysely<DatabaseSchema>,
  input: BaselineStageInput,
): Promise<void> {
  await sql`
    insert into stage_transitions (
      id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, attempt_id,
      confirmed_external_revision, entered_at, exited_at, duration_ms, timestamp_source
    ) values (
      ${input.id}, ${input.workRef.kind}, ${input.workRef.id}, null, ${input.toStage},
      ${input.reason}, null, null, ${input.enteredAt}, null, null, ${input.timestampSource}
    )
  `.execute(database);
}

export async function transitionStage(
  database: Kysely<DatabaseSchema>,
  input: StageTransitionInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    if (input.attemptId !== null) {
      const attempt = await sql<{ id: string }>`
        select id from attempts
        where id = ${input.attemptId}
          and work_ref_kind = ${input.workRef.kind}
          and work_ref_id = ${input.workRef.id}
      `.execute(transaction);
      if (attempt.rows.length !== 1) {
        throw new Error(`Attempt ${input.attemptId} does not belong to the stage work reference`);
      }
    }

    const open = await sql<{ entered_at: string }>`
      select entered_at from stage_transitions
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and to_stage = ${input.expectedFromStage}
        and exited_at is null
    `.execute(transaction);
    const current = open.rows[0];
    if (!current) {
      throw new Error(`Open stage does not match expected stage ${input.expectedFromStage}`);
    }
    const durationMs = durationBetween(current.entered_at, input.enteredAt);
    const close = await sql`
      update stage_transitions
      set exited_at = ${input.enteredAt}, duration_ms = ${durationMs}
      where work_ref_kind = ${input.workRef.kind}
        and work_ref_id = ${input.workRef.id}
        and to_stage = ${input.expectedFromStage}
        and exited_at is null
    `.execute(transaction);
    if (close.numAffectedRows !== 1n) {
      throw new Error(`Open stage does not match expected stage ${input.expectedFromStage}`);
    }
    await sql`
      insert into stage_transitions (
        id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, attempt_id,
        confirmed_external_revision, entered_at, exited_at, duration_ms, timestamp_source
      ) values (
        ${input.id}, ${input.workRef.kind}, ${input.workRef.id}, ${input.expectedFromStage},
        ${input.toStage}, ${input.reason}, ${input.attemptId},
        ${input.confirmedExternalRevision}, ${input.enteredAt}, null, null,
        ${input.timestampSource}
      )
    `.execute(transaction);
  });
}
