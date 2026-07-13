import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { createDispatch } from "./dispatch-store.js";
import { finishAttempt } from "./finish-attempt.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-finish-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "now", "hash", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  const insertLedger = opened.sqlite.prepare(`
    insert into budget_ledgers (
      id, scope, scope_id, unit, base_limit, effective_limit, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLedger.run("attempt-ledger", "attempt", "attempt-1", "tokens", 400, 400, "now");
  insertLedger.run("issue-ledger", "issue", "issue-1", "tokens", 1000, 1000, "now");
  insertLedger.run("fleet-ledger", "rolling_24h", "fleet", "tokens", 5000, 5000, "now");
  await createDispatch(opened.database, {
    attempt: {
      attemptNumber: 1,
      changeClass: "standard",
      computeProfile: "standard",
      configSnapshotId: "config-1",
      costUsd: null,
      id: "attempt-1",
      model: "provider-model",
      priceTableVersion: null,
      reasoningEffort: "medium",
      role: "implementation",
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
    workRef: { id: "issue-1", kind: "issue" },
  });
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const finish = {
  attemptId: "attempt-1",
  costUsd: null,
  endedAt: "2026-07-13T10:01:00Z",
  failureClass: null,
  nextClaim: { mode: "Ready" as const, reason: "review_ready" },
  reservationId: "reservation-1",
  settledLedgers: [
    { actualAmount: 150, id: "attempt-ledger" },
    { actualAmount: 150, id: "issue-ledger" },
    { actualAmount: 150, id: "fleet-ledger" },
  ],
  terminalResult: {
    id: "result-1",
    kind: "implementation_outcome",
    payload: { status: "completed" },
    role: "implementation",
  },
  usage: { inputTokens: 100, outputTokens: 50 },
  workRef: { id: "issue-1", kind: "issue" as const },
};

describe("attempt closure transaction", () => {
  it("atomically closes the attempt, settles budgets, and keeps a Ready claim", async () => {
    await finishAttempt(opened.database, finish);

    expect(
      opened.sqlite
        .prepare(
          "select status, ended_at, terminal_result_id, input_tokens, output_tokens, total_tokens from attempts",
        )
        .get(),
    ).toEqual({
      ended_at: "2026-07-13T10:01:00Z",
      input_tokens: 100,
      output_tokens: 50,
      status: "closed",
      terminal_result_id: "result-1",
      total_tokens: 150,
    });
    expect(opened.sqlite.prepare("select mode, expires_at from claims").get()).toEqual({
      expires_at: null,
      mode: "Ready",
    });
    expect(
      opened.sqlite.prepare("select id, reserved, consumed from budget_ledgers order by id").all(),
    ).toEqual([
      { consumed: 150, id: "attempt-ledger", reserved: 0 },
      { consumed: 150, id: "fleet-ledger", reserved: 0 },
      { consumed: 150, id: "issue-ledger", reserved: 0 },
    ]);
  });

  it("rejects duplicate closure without changing the committed terminal result", async () => {
    await finishAttempt(opened.database, finish);

    await expect(
      finishAttempt(opened.database, {
        ...finish,
        terminalResult: { ...finish.terminalResult, id: "result-2" },
      }),
    ).rejects.toThrow("Attempt attempt-1 is already closed or missing");
    expect(opened.sqlite.prepare("select id from terminal_results").all()).toEqual([
      { id: "result-1" },
    ]);
  });

  it("releases terminal work by deleting its active claim in the closure transaction", async () => {
    await finishAttempt(opened.database, {
      ...finish,
      nextClaim: { mode: "Released", reason: "tracker_terminal" },
    });

    expect(opened.sqlite.prepare("select count(*) as count from claims").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select status from attempts").get()).toEqual({
      status: "closed",
    });
  });
});
