import { isLiveSession, type LiveSession } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export async function startLiveAttemptSession(
  database: Kysely<DatabaseSchema>,
  session: LiveSession,
): Promise<void> {
  if (
    !isLiveSession(session) ||
    session.last_total_tokens !== session.last_input_tokens + session.last_output_tokens
  ) {
    throw new Error("live_session.invalid");
  }
  await database.transaction().execute(async (transaction) => {
    const attempt = await sql`
      update attempts
      set status = 'running', input_tokens = ${session.last_input_tokens},
          output_tokens = ${session.last_output_tokens}, total_tokens = ${session.last_total_tokens}
      where id = ${session.attempt_id} and status = 'created'
    `.execute(transaction);
    if (attempt.numAffectedRows !== 1n) {
      throw new Error("live_session.attempt_not_created");
    }
    await sql`
      insert into live_sessions (
        attempt_id, session_id, thread_id, turn_id, process_id, process_group_id,
        adapter_version, protocol_schema_hash, last_event, last_event_at,
        turn_count, last_input_tokens, last_output_tokens, last_total_tokens,
        ownership_verified_at
      ) values (
        ${session.attempt_id}, ${session.session_id}, ${session.thread_id}, ${session.turn_id},
        ${session.process_id}, ${session.process_group_id}, ${session.adapter_version},
        ${session.protocol_schema_hash}, ${session.last_event}, ${session.last_event_at},
        ${session.turn_count}, ${session.last_input_tokens}, ${session.last_output_tokens},
        ${session.last_total_tokens}, ${session.ownership_verified_at}
      )
    `.execute(transaction);
  });
}

export async function recordLiveSessionEvent(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    event: string;
    eventAt: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    turnCount: number;
    turnId: string | null;
  },
): Promise<void> {
  if (
    input.event.length === 0 ||
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens < 0 ||
    !Number.isSafeInteger(input.totalTokens) ||
    input.totalTokens !== input.inputTokens + input.outputTokens ||
    !Number.isSafeInteger(input.turnCount) ||
    input.turnCount < 0 ||
    !Number.isFinite(Date.parse(input.eventAt))
  ) {
    throw new Error("live_session.invalid_event");
  }

  await database.transaction().execute(async (transaction) => {
    const session = await sql`
      update live_sessions
      set turn_id = ${input.turnId}, last_event = ${input.event},
          last_event_at = ${input.eventAt}, turn_count = ${input.turnCount},
          last_input_tokens = ${input.inputTokens},
          last_output_tokens = ${input.outputTokens},
          last_total_tokens = ${input.totalTokens}
      where attempt_id = ${input.attemptId}
        and turn_count <= ${input.turnCount}
        and last_input_tokens <= ${input.inputTokens}
        and last_output_tokens <= ${input.outputTokens}
        and last_total_tokens <= ${input.totalTokens}
        and julianday(last_event_at) <= julianday(${input.eventAt})
    `.execute(transaction);
    if (session.numAffectedRows !== 1n) throw new Error("live_session.event_regression");

    const attempt = await sql`
      update attempts
      set input_tokens = ${input.inputTokens}, output_tokens = ${input.outputTokens},
          total_tokens = ${input.totalTokens}
      where id = ${input.attemptId} and status = 'running'
    `.execute(transaction);
    if (attempt.numAffectedRows !== 1n) throw new Error("live_session.attempt_not_running");
  });
}
