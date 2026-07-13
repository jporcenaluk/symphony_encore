import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import { beginServiceRun, completeServiceRecovery } from "./service-run-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("service-run recovery", () => {
  it("closes the prior run only after ownership reconciliation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-service-run-"));
    directories.push(directory);
    const filename = path.join(directory, "symphony.sqlite3");
    const first = openDatabase(filename);
    await applyMigrations(first.database);
    first.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    await beginServiceRun(first.database, {
      hostId: "host-1",
      id: "run-1",
      serviceVersion: "0.0.0",
      startReason: "startup",
      startedAt: "2026-07-13T10:00:00Z",
      startupConfigSnapshotId: "config-1",
    });
    await completeServiceRecovery(first.database, {
      completedAt: "2026-07-13T10:00:01Z",
      ownershipReconciled: true,
      serviceRunId: "run-1",
    });
    await first.close();

    const restarted = openDatabase(filename);
    await beginServiceRun(restarted.database, {
      hostId: "host-1",
      id: "run-2",
      serviceVersion: "0.0.0",
      startReason: "restart",
      startedAt: "2026-07-13T10:01:00Z",
      startupConfigSnapshotId: "config-1",
    });
    expect(
      restarted.sqlite.prepare("select id, status from service_runs order by started_at").all(),
    ).toEqual([
      { id: "run-1", status: "ready" },
      { id: "run-2", status: "recovering" },
    ]);

    await completeServiceRecovery(restarted.database, {
      completedAt: "2026-07-13T10:01:02Z",
      ownershipReconciled: true,
      serviceRunId: "run-2",
    });
    expect(
      restarted.sqlite
        .prepare("select id, status, ended_at, end_reason from service_runs order by started_at")
        .all(),
    ).toEqual([
      {
        end_reason: "restart_reconciled",
        ended_at: "2026-07-13T10:01:02Z",
        id: "run-1",
        status: "interrupted",
      },
      { end_reason: null, ended_at: null, id: "run-2", status: "ready" },
    ]);
    await restarted.close();
  });

  it("fails closed when process ownership has not been reconciled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-service-run-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    await beginServiceRun(opened.database, {
      hostId: "host-1",
      id: "run-1",
      serviceVersion: "0.0.0",
      startReason: "startup",
      startedAt: "2026-07-13T10:00:00Z",
      startupConfigSnapshotId: "config-1",
    });

    await expect(
      completeServiceRecovery(opened.database, {
        completedAt: "2026-07-13T10:00:01Z",
        ownershipReconciled: false,
        serviceRunId: "run-1",
      }),
    ).rejects.toThrow("recovery.process_ownership_unverified");
    expect(opened.sqlite.prepare("select status from service_runs").get()).toEqual({
      status: "recovering",
    });
    await opened.close();
  });
});
