import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-dispatch-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
  opened.sqlite
    .prepare(`insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "config-1",
      "2026-07-13T10:00:00Z",
      "workflow-hash",
      0,
      "{}",
      "{}",
      "{}",
      "{}",
      "prompt-hash",
      "{}",
    );
  const insertLedger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLedger.run("attempt-ledger", "attempt", "attempt-1", "tokens", 400, 400, "now");
  insertLedger.run("issue-ledger", "issue", "issue-1", "tokens", 1000, 1000, "now");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet", "tokens", 5000, 5000, "now");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const dispatch = {
  attempt: {
    attemptNumber: 1,
    changeClass: "standard" as const,
    computeProfile: "standard" as const,
    configSnapshotId: "config-1",
    costUsd: null,
    id: "attempt-1",
    model: "provider-model",
    priceTableVersion: null,
    reasoningEffort: "medium",
    role: "implementation" as const,
    routingReasons: ["classification.standard"],
    startedAt: "2026-07-13T10:00:00Z",
    workspacePath: "/tmp/work/issue-1",
  },
  claim: {
    acquiredAt: "2026-07-13T10:00:00Z",
    expiresAt: "2026-07-13T10:02:00Z",
    holder: "service-1",
    originStage: "Todo",
    reason: "dispatch",
  },
  reservation: {
    id: "reservation-1",
    ledgers: [
      { amount: 200, id: "attempt-ledger", version: 1 },
      { amount: 200, id: "issue-ledger", version: 1 },
      { amount: 200, id: "fleet-ledger", version: 1 },
    ],
  },
  workRef: { kind: "issue" as const, id: "issue-1" },
};

describe("dispatch transaction", () => {
  it("commits the claim, attempt, and every budget reservation together", async () => {
    await createDispatch(opened.database, dispatch);

    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 1,
    });
    expect(
      opened.sqlite.prepare("select count(*) as count from budget_reservation_ledgers").get(),
    ).toEqual({ count: 3 });
    expect(
      opened.sqlite.prepare("select id, reserved from budget_ledgers order by id").all(),
    ).toEqual([
      { id: "attempt-ledger", reserved: 200 },
      { id: "fleet-ledger", reserved: 200 },
      { id: "issue-ledger", reserved: 200 },
    ]);
  });

  it("rolls back every write when a work reference is already claimed", async () => {
    await createDispatch(opened.database, dispatch);

    await expect(
      createDispatch(opened.database, {
        ...dispatch,
        attempt: { ...dispatch.attempt, attemptNumber: 2, id: "attempt-2" },
        reservation: { ...dispatch.reservation, id: "reservation-2" },
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/u);

    expect(
      opened.sqlite.prepare("select count(*) as count from attempts where id = 'attempt-2'").get(),
    ).toEqual({ count: 0 });
    expect(
      opened.sqlite
        .prepare("select count(*) as count from budget_reservations where id = 'reservation-2'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      opened.sqlite.prepare("select reserved from budget_ledgers where id = 'issue-ledger'").get(),
    ).toEqual({ reserved: 200 });
  });

  it("rolls back when any ledger cannot fit the reservation", async () => {
    opened.sqlite
      .prepare("update budget_ledgers set consumed = 900 where id = 'issue-ledger'")
      .run();

    await expect(createDispatch(opened.database, dispatch)).rejects.toThrow(
      "Budget reservation denied for ledger issue-ledger",
    );
    expect(opened.sqlite.prepare("select count(*) as count from attempts").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite
        .prepare("select reserved from budget_ledgers where id = 'attempt-ledger'")
        .get(),
    ).toEqual({ reserved: 0 });
  });
});
