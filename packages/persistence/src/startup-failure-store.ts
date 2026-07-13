import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface RecordStartupFailureInput {
  details: Readonly<Record<string, unknown>>;
  id: string;
  occurredAt: string;
  reasonCode: string;
}

export async function recordStartupFailure(
  database: Kysely<DatabaseSchema>,
  input: RecordStartupFailureInput,
): Promise<void> {
  await sql`
    insert into startup_failures (id, occurred_at, reason_code, details_json)
    values (${input.id}, ${input.occurredAt}, ${input.reasonCode}, ${JSON.stringify(input.details)})
  `.execute(database);
}
