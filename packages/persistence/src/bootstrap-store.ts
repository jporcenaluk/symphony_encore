import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export type BootstrapEligibility =
  | { kind: "pristine" }
  | { kind: "initialized"; operatorCount: number }
  | { kind: "operator_store_missing_nonpristine"; populatedTables: string[] };

export async function inspectBootstrapEligibility(
  database: Kysely<DatabaseSchema>,
): Promise<BootstrapEligibility> {
  const operators = await sql<{ count: number }>`select count(*) as count from operators`.execute(
    database,
  );
  const operatorCount = operators.rows[0]?.count ?? 0;
  if (operatorCount > 0) return { kind: "initialized", operatorCount };

  const tables = await sql<{ name: string }>`
    select name from sqlite_schema
    where type = 'table' and name not in ('schema_migrations', 'sqlite_sequence')
    order by name
  `.execute(database);
  const populatedTables: string[] = [];
  for (const table of tables.rows) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table.name)) throw new Error("bootstrap.invalid_table_name");
    const count = await sql<{ count: number }>`
      select count(*) as count from ${sql.raw(`"${table.name}"`)}
    `.execute(database);
    if ((count.rows[0]?.count ?? 0) > 0) populatedTables.push(table.name);
  }
  if (populatedTables.length === 0) return { kind: "pristine" };
  return { kind: "operator_store_missing_nonpristine", populatedTables };
}
