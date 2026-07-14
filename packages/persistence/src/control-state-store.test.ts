import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readControlState, readServiceStatus } from "./control-state-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { beginServiceRun, completeServiceRecovery } from "./service-run-store.js";

const openedDatabases: OpenedDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-control-state-"));
  temporaryDirectories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  openedDatabases.push(opened);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  await beginServiceRun(opened.database, {
    hostId: "host-1",
    id: "run-1",
    serviceVersion: "1.2.3",
    startReason: "startup",
    startedAt: "2026-07-13T10:00:00Z",
    startupConfigSnapshotId: "config-1",
  });
  return opened;
}

describe("Control API state projection", () => {
  it("keeps dispatch and mutations disabled while the service is recovering", async () => {
    const opened = await fixture();

    await expect(readServiceStatus(opened.database)).resolves.toEqual({
      id: "run-1",
      state: "recovering",
    });
    await expect(readControlState(opened.database)).resolves.toEqual({
      dispatch_enabled: false,
      mutations_enabled: false,
      service_run: {
        id: "run-1",
        service_version: "1.2.3",
        started_at: "2026-07-13T10:00:00Z",
        status: "recovering",
      },
      version: "service-run:run-1:recovering",
    });
  });

  it("enables control activity only after durable readiness is committed", async () => {
    const opened = await fixture();
    await completeServiceRecovery(opened.database, {
      completedAt: "2026-07-13T10:00:02Z",
      ownershipReconciled: true,
      serviceRunId: "run-1",
    });

    await expect(readControlState(opened.database)).resolves.toMatchObject({
      dispatch_enabled: true,
      mutations_enabled: true,
      service_run: { status: "ready" },
      version: "service-run:run-1:ready",
    });
  });

  it("fails closed when no active ServiceRun exists", async () => {
    const opened = await fixture();
    opened.sqlite
      .prepare("update service_runs set status = 'stopped', ended_at = '2026-07-13T10:01:00Z'")
      .run();

    await expect(readServiceStatus(opened.database)).rejects.toThrow(
      "control_state.active_service_run_missing",
    );
  });
});
