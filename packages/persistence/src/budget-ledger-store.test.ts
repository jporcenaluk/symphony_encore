import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareDispatchBudget } from "./budget-ledger-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-budget-ledgers-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("dispatch budget ledger preparation", () => {
  it("creates versioned attempt, issue, and fleet reservations for tokens and priced USD", async () => {
    await expect(
      prepareDispatchBudget(opened.database, {
        attemptId: "attempt-1",
        estimatedTokens: 200,
        estimatedUsd: 1.5,
        issueId: "issue-1",
        limits: {
          attemptTokens: 400,
          attemptUsd: 5,
          fleetTokens: 10_000,
          fleetUsd: 50,
          issueTokens: 2_000,
          issueUsd: 10,
        },
        updatedAt: "2026-07-13T10:00:00Z",
      }),
    ).resolves.toEqual([
      { amount: 200, id: "budget:attempt:attempt-1:tokens", version: 1 },
      { amount: 1.5, id: "budget:attempt:attempt-1:usd", version: 1 },
      { amount: 200, id: "budget:issue:issue-1:tokens", version: 1 },
      { amount: 1.5, id: "budget:issue:issue-1:usd", version: 1 },
      { amount: 200, id: "budget:fleet:rolling_24h:tokens", version: 1 },
      { amount: 1.5, id: "budget:fleet:rolling_24h:usd", version: 1 },
    ]);
  });

  it("preserves accounting and adjustments while versioning changed hot issue and fleet limits", async () => {
    const first = {
      attemptId: "attempt-1",
      estimatedTokens: 200,
      estimatedUsd: null,
      issueId: "issue-1",
      limits: {
        attemptTokens: 400,
        attemptUsd: 5,
        fleetTokens: 10_000,
        fleetUsd: 50,
        issueTokens: 2_000,
        issueUsd: 10,
      },
      updatedAt: "2026-07-13T10:00:00Z",
    };
    await prepareDispatchBudget(opened.database, first);
    opened.sqlite
      .prepare(
        `update budget_ledgers
         set adjustment = 100, effective_limit = 2100, consumed = 300
         where id = 'budget:issue:issue-1:tokens'`,
      )
      .run();

    const reservations = await prepareDispatchBudget(opened.database, {
      ...first,
      limits: { ...first.limits, fleetTokens: 12_000, issueTokens: 3_000 },
      updatedAt: "2026-07-13T10:01:00Z",
    });

    expect(reservations).toContainEqual({
      amount: 200,
      id: "budget:issue:issue-1:tokens",
      version: 2,
    });
    expect(
      opened.sqlite
        .prepare(
          `select base_limit, adjustment, effective_limit, consumed, version
           from budget_ledgers where id = 'budget:issue:issue-1:tokens'`,
        )
        .get(),
    ).toEqual({
      adjustment: 100,
      base_limit: 3_000,
      consumed: 300,
      effective_limit: 3_100,
      version: 2,
    });
  });

  it("omits USD ledgers for unpriced adapters", async () => {
    const reservations = await prepareDispatchBudget(opened.database, {
      attemptId: "attempt-1",
      estimatedTokens: 200,
      estimatedUsd: null,
      issueId: "issue-1",
      limits: {
        attemptTokens: 400,
        attemptUsd: 5,
        fleetTokens: 10_000,
        fleetUsd: 50,
        issueTokens: 2_000,
        issueUsd: 10,
      },
      updatedAt: "2026-07-13T10:00:00Z",
    });

    expect(reservations).toHaveLength(3);
    expect(reservations.every((reservation) => reservation.id.endsWith(":tokens"))).toBe(true);
  });

  it("creates a first-class SystemJob work budget without an issue ledger", async () => {
    const reservations = await prepareDispatchBudget(opened.database, {
      attemptId: "attempt-repair-1",
      estimatedTokens: 200,
      estimatedUsd: null,
      limits: {
        attemptTokens: 400,
        attemptUsd: 5,
        fleetTokens: 10_000,
        fleetUsd: 50,
        issueTokens: 2_000,
        issueUsd: 10,
      },
      systemJobId: "repair-1",
      updatedAt: "2026-07-13T10:00:00Z",
    });

    expect(reservations).toContainEqual({
      amount: 200,
      id: "budget:system_job:repair-1:tokens",
      version: 1,
    });
    expect(
      opened.sqlite
        .prepare("select scope, scope_id from budget_ledgers where id = ?")
        .get("budget:system_job:repair-1:tokens"),
    ).toEqual({ scope: "system_job", scope_id: "repair-1" });
  });
});
