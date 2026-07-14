import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface UsageStateRow {
  attempt_cost_usd: number | null;
  attempt_status: string;
  last_event_at: string;
  last_input_tokens: number;
  last_output_tokens: number;
  last_total_tokens: number;
  turn_count: number;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

export async function recordAttemptUsageSample(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    billableCategories: Readonly<Record<string, number>>;
    costUsd: number | null;
    id: string;
    inputTokens: number;
    outputTokens: number;
    serviceRunId: string;
    timestamp: string;
    totalTokens: number;
    turnCount: number;
    turnId: string | null;
  },
): Promise<void> {
  validateUsageSample(input);
  await database.transaction().execute(async (transaction) => {
    const state = await sql<UsageStateRow>`
      select live_sessions.last_input_tokens, live_sessions.last_output_tokens,
             live_sessions.last_total_tokens, live_sessions.last_event_at,
             live_sessions.turn_count, attempts.status as attempt_status,
             attempts.cost_usd as attempt_cost_usd,
             attempts.work_ref_kind, attempts.work_ref_id
      from live_sessions
      join attempts on attempts.id = live_sessions.attempt_id
      where attempts.id = ${input.attemptId}
    `.execute(transaction);
    const previous = state.rows[0];
    if (previous?.attempt_status !== "running") {
      throw new Error("usage_sample.live_attempt_missing");
    }
    if (
      input.inputTokens < previous.last_input_tokens ||
      input.outputTokens < previous.last_output_tokens ||
      input.totalTokens < previous.last_total_tokens ||
      input.turnCount < previous.turn_count ||
      Date.parse(input.timestamp) < Date.parse(previous.last_event_at) ||
      (previous.attempt_cost_usd !== null &&
        (input.costUsd === null || input.costUsd < previous.attempt_cost_usd))
    ) {
      throw new Error("usage_sample.regression");
    }
    const derivedInputTokens = input.inputTokens - previous.last_input_tokens;
    const derivedOutputTokens = input.outputTokens - previous.last_output_tokens;
    const derivedTotalTokens = input.totalTokens - previous.last_total_tokens;
    if (derivedTotalTokens !== derivedInputTokens + derivedOutputTokens) {
      throw new Error("usage_sample.delta_invalid");
    }

    await sql`
      insert into usage_samples (
        id, service_run_id, work_ref_kind, work_ref_id, attempt_id, system_job_id,
        timestamp, input_tokens, output_tokens, total_tokens, billable_categories_json,
        derived_input_tokens, derived_output_tokens, derived_total_tokens, cost_usd
      ) values (
        ${input.id}, ${input.serviceRunId}, ${previous.work_ref_kind},
        ${previous.work_ref_id}, ${input.attemptId}, null, ${input.timestamp},
        ${input.inputTokens}, ${input.outputTokens}, ${input.totalTokens},
        ${JSON.stringify(input.billableCategories)}, ${derivedInputTokens},
        ${derivedOutputTokens}, ${derivedTotalTokens}, ${input.costUsd}
      )
    `.execute(transaction);
    const session = await sql`
      update live_sessions
      set turn_id = ${input.turnId}, last_event = 'token_usage',
          last_event_at = ${input.timestamp}, turn_count = ${input.turnCount},
          last_input_tokens = ${input.inputTokens},
          last_output_tokens = ${input.outputTokens},
          last_total_tokens = ${input.totalTokens}
      where attempt_id = ${input.attemptId}
        and last_input_tokens = ${previous.last_input_tokens}
        and last_output_tokens = ${previous.last_output_tokens}
        and last_total_tokens = ${previous.last_total_tokens}
        and turn_count = ${previous.turn_count}
    `.execute(transaction);
    if (session.numAffectedRows !== 1n) throw new Error("usage_sample.concurrent_update");
    const attempt = await sql`
      update attempts
      set input_tokens = ${input.inputTokens}, output_tokens = ${input.outputTokens},
          total_tokens = ${input.totalTokens}, cost_usd = ${input.costUsd}
      where id = ${input.attemptId} and status = 'running'
    `.execute(transaction);
    if (attempt.numAffectedRows !== 1n) throw new Error("usage_sample.attempt_not_running");
  });
}

function validateUsageSample(input: {
  attemptId: string;
  billableCategories: Readonly<Record<string, number>>;
  costUsd: number | null;
  id: string;
  inputTokens: number;
  outputTokens: number;
  serviceRunId: string;
  timestamp: string;
  totalTokens: number;
  turnCount: number;
}): void {
  if (!input.id || !input.attemptId || !input.serviceRunId) {
    throw new Error("usage_sample.identity_invalid");
  }
  if (
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens < 0 ||
    !Number.isSafeInteger(input.totalTokens) ||
    input.totalTokens !== input.inputTokens + input.outputTokens ||
    !Number.isSafeInteger(input.turnCount) ||
    input.turnCount < 0 ||
    (input.costUsd !== null && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) ||
    !Number.isFinite(Date.parse(input.timestamp)) ||
    Object.entries(input.billableCategories).some(
      ([name, value]) => !name || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error("usage_sample.invalid");
  }
}
