import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, CORE_MIGRATIONS, type OpenedDatabase, openDatabase } from "./database.js";

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function temporaryDatabase(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-db-"));
  temporaryDirectories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  openedDatabases.push(opened);
  return opened;
}

describe("production migrations", () => {
  it("enables WAL and foreign keys and applies ordered migrations idempotently", async () => {
    const opened = await temporaryDatabase();

    await applyMigrations(opened.database);
    await applyMigrations(opened.database);

    expect(opened.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(opened.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      opened.sqlite.prepare("select version, name from schema_migrations order by version").all(),
    ).toEqual([
      { name: "core_control_plane", version: 1 },
      { name: "durable_stage_transitions", version: 2 },
      { name: "configuration_overrides_and_operator_audit", version: 3 },
      { name: "exact_configuration_acknowledgments", version: 4 },
      { name: "durable_domain_records", version: 5 },
      { name: "verification_evidence_blobs", version: 6 },
      { name: "append_only_event_records", version: 7 },
      { name: "operator_identity_and_sessions", version: 8 },
      { name: "startup_failure_records", version: 9 },
    ]);
  });

  it("creates a durable table for every remaining Section 3 entity", async () => {
    const opened = await temporaryDatabase();
    await applyMigrations(opened.database);

    const tables = opened.sqlite
      .prepare("select name from sqlite_schema where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_approval_requests",
        "budget_adjustments",
        "evidence_blobs",
        "event_records",
        "guard_decisions",
        "issues",
        "lessons",
        "live_sessions",
        "log_records",
        "mutation_authorizations",
        "operator_questions",
        "operator_sessions",
        "operators",
        "local_operator_credentials",
        "bootstrap_state",
        "parked_work",
        "plans",
        "repository_links",
        "retry_entries",
        "review_records",
        "review_sets",
        "rules",
        "side_effect_intents",
        "side_effect_receipts",
        "startup_failures",
        "system_jobs",
        "usage_samples",
        "verification_records",
      ]),
    );
  });

  it("rejects an altered checksum for an applied migration", async () => {
    const opened = await temporaryDatabase();
    await applyMigrations(opened.database);

    await expect(
      applyMigrations(opened.database, [{ ...CORE_MIGRATIONS[0], checksum: "sha256:altered" }]),
    ).rejects.toThrow("Applied migration 1 checksum does not match repository migration");
  });

  it("enforces one durable claim per work reference", async () => {
    const opened = await temporaryDatabase();
    await applyMigrations(opened.database);
    const insert = opened.sqlite.prepare(`
      insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "issue",
      "issue-1",
      "service-1",
      "Running",
      "2026-07-13T10:00:00Z",
      "2026-07-13T10:00:00Z",
      "2026-07-13T10:02:00Z",
      "Todo",
      "dispatch",
    );

    expect(() =>
      insert.run(
        "issue",
        "issue-1",
        "service-2",
        "Running",
        "2026-07-13T10:00:01Z",
        "2026-07-13T10:00:01Z",
        "2026-07-13T10:02:01Z",
        "Todo",
        "duplicate",
      ),
    ).toThrow(/UNIQUE constraint failed/u);
  });
});
