import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface AttemptUsageHistoryEntry {
  costUsd: number | null;
  totalTokens: number;
}

export async function nextAttemptNumber(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<number> {
  if (!workRef.id || (workRef.kind !== "issue" && workRef.kind !== "system_job")) {
    throw new Error("dispatch_planning.work_ref_invalid");
  }
  const result = await sql<{ maximum: number | null }>`
    select max(attempt_number) as maximum
    from attempts
    where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
  `.execute(database);
  const maximum = result.rows[0]?.maximum ?? 0;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum === Number.MAX_SAFE_INTEGER) {
    throw new Error("dispatch_planning.attempt_number_invalid");
  }
  return maximum + 1;
}

export async function listAttemptUsageHistory(
  database: Kysely<DatabaseSchema>,
  input: { limit: number; profile: string; role: string },
): Promise<AttemptUsageHistoryEntry[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new Error("dispatch_planning.history_limit_invalid");
  }
  if (!input.profile || !input.role) throw new Error("dispatch_planning.history_scope_invalid");
  const result = await sql<{
    cost_usd: number | null;
    total_tokens: number;
  }>`
    select recent.total_tokens, recent.cost_usd
    from (
      select id, ended_at, total_tokens, cost_usd
      from attempts
      where status = 'closed'
        and ended_at is not null
        and role = ${input.role}
        and compute_profile = ${input.profile}
      order by ended_at desc, id desc
      limit ${input.limit}
    ) as recent
    order by recent.ended_at, recent.id
  `.execute(database);
  return result.rows.map((row) => {
    if (
      !Number.isSafeInteger(row.total_tokens) ||
      row.total_tokens < 0 ||
      (row.cost_usd !== null && (!Number.isFinite(row.cost_usd) || row.cost_usd < 0))
    ) {
      throw new Error("dispatch_planning.history_row_invalid");
    }
    return { costUsd: row.cost_usd, totalTokens: row.total_tokens };
  });
}
