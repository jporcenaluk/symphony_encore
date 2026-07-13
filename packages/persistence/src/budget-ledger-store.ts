import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface DispatchBudgetLimits {
  attemptTokens: number;
  attemptUsd: number;
  fleetTokens: number;
  fleetUsd: number;
  issueTokens: number;
  issueUsd: number;
}

export interface DispatchBudgetReservationLedger {
  amount: number;
  id: string;
  version: number;
}

interface LedgerRow {
  adjustment: number;
  base_limit: number;
  version: number;
}

export async function prepareDispatchBudget(
  database: Kysely<DatabaseSchema>,
  input: {
    attemptId: string;
    estimatedTokens: number;
    estimatedUsd: number | null;
    limits: DispatchBudgetLimits;
    updatedAt: string;
  } & ({ issueId: string; systemJobId?: never } | { issueId?: never; systemJobId: string }),
): Promise<DispatchBudgetReservationLedger[]> {
  requirePositive(input.estimatedTokens, "budget.invalid_token_estimate");
  if (input.estimatedUsd !== null) {
    requireNonNegative(input.estimatedUsd, "budget.invalid_usd_estimate");
  }
  for (const [name, value] of Object.entries(input.limits)) {
    requirePositive(value, `budget.invalid_limit:${name}`);
  }
  const workScope =
    input.issueId !== undefined
      ? { id: input.issueId, scope: "issue" as const }
      : { id: input.systemJobId, scope: "system_job" as const };
  if (!workScope.id) throw new Error("budget.invalid_work_scope");
  if (!Number.isFinite(Date.parse(input.updatedAt))) throw new Error("budget.invalid_timestamp");

  return database.transaction().execute(async (transaction) => {
    const definitions = [
      {
        amount: input.estimatedTokens,
        baseLimit: input.limits.attemptTokens,
        hot: false,
        id: `budget:attempt:${input.attemptId}:tokens`,
        scope: "attempt" as const,
        scopeId: input.attemptId,
        unit: "tokens" as const,
      },
      ...(input.estimatedUsd === null
        ? []
        : [
            {
              amount: input.estimatedUsd,
              baseLimit: input.limits.attemptUsd,
              hot: false,
              id: `budget:attempt:${input.attemptId}:usd`,
              scope: "attempt" as const,
              scopeId: input.attemptId,
              unit: "usd" as const,
            },
          ]),
      {
        amount: input.estimatedTokens,
        baseLimit: input.limits.issueTokens,
        hot: true,
        id: `budget:${workScope.scope}:${workScope.id}:tokens`,
        scope: workScope.scope,
        scopeId: workScope.id,
        unit: "tokens" as const,
      },
      ...(input.estimatedUsd === null
        ? []
        : [
            {
              amount: input.estimatedUsd,
              baseLimit: input.limits.issueUsd,
              hot: true,
              id: `budget:${workScope.scope}:${workScope.id}:usd`,
              scope: workScope.scope,
              scopeId: workScope.id,
              unit: "usd" as const,
            },
          ]),
      {
        amount: input.estimatedTokens,
        baseLimit: input.limits.fleetTokens,
        hot: true,
        id: "budget:fleet:rolling_24h:tokens",
        scope: "rolling_24h" as const,
        scopeId: "fleet",
        unit: "tokens" as const,
      },
      ...(input.estimatedUsd === null
        ? []
        : [
            {
              amount: input.estimatedUsd,
              baseLimit: input.limits.fleetUsd,
              hot: true,
              id: "budget:fleet:rolling_24h:usd",
              scope: "rolling_24h" as const,
              scopeId: "fleet",
              unit: "usd" as const,
            },
          ]),
    ];
    const reservations: DispatchBudgetReservationLedger[] = [];
    for (const definition of definitions) {
      const version = await ensureLedger(transaction, {
        ...definition,
        updatedAt: input.updatedAt,
      });
      reservations.push({ amount: definition.amount, id: definition.id, version });
    }
    return reservations;
  });
}

async function ensureLedger(
  transaction: Transaction<DatabaseSchema>,
  input: {
    baseLimit: number;
    hot: boolean;
    id: string;
    scope: "attempt" | "issue" | "system_job" | "rolling_24h";
    scopeId: string;
    unit: "tokens" | "usd";
    updatedAt: string;
  },
): Promise<number> {
  const existing = await sql<LedgerRow>`
    select base_limit, adjustment, version from budget_ledgers where id = ${input.id}
  `.execute(transaction);
  const row = existing.rows[0];
  if (!row) {
    await sql`
      insert into budget_ledgers (
        id, scope, scope_id, unit, base_limit, adjustment, effective_limit,
        reserved, consumed, overrun, version, updated_at
      ) values (
        ${input.id}, ${input.scope}, ${input.scopeId}, ${input.unit}, ${input.baseLimit},
        0, ${input.baseLimit}, 0, 0, 0, 1, ${input.updatedAt}
      )
    `.execute(transaction);
    return 1;
  }
  if (row.base_limit === input.baseLimit) return row.version;
  if (!input.hot) throw new Error(`budget.attempt_limit_changed:${input.id}`);
  const effectiveLimit = input.baseLimit + row.adjustment;
  requirePositive(effectiveLimit, `budget.invalid_effective_limit:${input.id}`);
  const update = await sql`
    update budget_ledgers
    set base_limit = ${input.baseLimit}, effective_limit = ${effectiveLimit},
        version = version + 1, updated_at = ${input.updatedAt}
    where id = ${input.id} and version = ${row.version}
  `.execute(transaction);
  if (update.numAffectedRows !== 1n) throw new Error(`budget.ledger_version_conflict:${input.id}`);
  return row.version + 1;
}

function requirePositive(value: number, code: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(code);
}

function requireNonNegative(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
}
