import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { recordStartupFailure } from "./startup-failure-store.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("startup failure records", () => {
  it("durably records a structured fail-closed startup result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-startup-failure-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    databases.push(opened);
    await applyMigrations(opened.database);

    await recordStartupFailure(opened.database, {
      details: {
        populated_tables: ["config_snapshots"],
        recovery_complete: true,
      },
      id: "failure-1",
      occurredAt: "2026-07-13T11:00:00Z",
      reasonCode: "operator_store_missing_nonpristine",
    });

    expect(opened.sqlite.prepare("select * from startup_failures").get()).toEqual({
      details_json: '{"populated_tables":["config_snapshots"],"recovery_complete":true}',
      id: "failure-1",
      occurred_at: "2026-07-13T11:00:00Z",
      reason_code: "operator_store_missing_nonpristine",
    });
  });
});
