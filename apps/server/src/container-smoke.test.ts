import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { verifyContainerRestartState } from "./container-smoke.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function migratedDatabase(
  rows: ReadonlyArray<{ endReason: string; id: string; status: string }>,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-container-smoke-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "symphony.sqlite3");
  const opened = openDatabase(databasePath);
  try {
    await applyMigrations(opened.database);
    const insert = opened.sqlite.prepare(`
      insert into service_runs (
        id, service_version, host_id, started_at, ended_at, status,
        startup_config_snapshot_id, start_reason, end_reason
      ) values (?, '0.0.0-test', 'container-host', ?, ?, ?, null, 'startup', ?)
    `);
    for (const [index, row] of rows.entries()) {
      insert.run(
        row.id,
        `2026-07-13T10:0${index}:00.000Z`,
        `2026-07-13T10:0${index}:30.000Z`,
        row.status,
        row.endReason,
      );
    }
  } finally {
    await opened.close();
  }
  return databasePath;
}

const expectedRows = [
  { endReason: "signal", id: "service-run-1", status: "stopped" },
  { endReason: "signal", id: "service-run-2", status: "stopped" },
] as const;

describe("container persistence smoke", () => {
  it("accepts exactly two stopped signal-terminated restart runs", async () => {
    const databasePath = await migratedDatabase(expectedRows);

    await expect(verifyContainerRestartState(databasePath)).resolves.toEqual({
      serviceRunCount: 2,
    });
  });

  it("rejects missing restart service runs without exposing database contents", async () => {
    const databasePath = await migratedDatabase([expectedRows[0]]);

    await expect(verifyContainerRestartState(databasePath)).rejects.toThrow(
      "container_smoke.service_run_count:expected=2:actual=1",
    );
  });

  it("rejects a service run that is not stopped", async () => {
    const databasePath = await migratedDatabase([
      expectedRows[0],
      { ...expectedRows[1], status: "failed" },
    ]);

    await expect(verifyContainerRestartState(databasePath)).rejects.toThrow(
      "container_smoke.service_run_status:expected=stopped",
    );
  });

  it("rejects a service run that did not stop from a signal", async () => {
    const databasePath = await migratedDatabase([
      expectedRows[0],
      { ...expectedRows[1], endReason: "shutdown" },
    ]);

    await expect(verifyContainerRestartState(databasePath)).rejects.toThrow(
      "container_smoke.service_run_end_reason:expected=signal",
    );
  });
});
