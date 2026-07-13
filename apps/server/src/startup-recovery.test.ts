import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMigrations,
  beginServiceRun,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { recoverStartupState } from "./startup-recovery.js";

const openedDatabases: OpenedDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<{
  opened: OpenedDatabase;
  owned: string;
  root: string;
  stale: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-recovery-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "workspaces");
  const owned = path.join(root, "issue-1");
  const stale = path.join(root, "issue-2");
  await Promise.all([mkdir(owned, { recursive: true }), mkdir(stale, { recursive: true })]);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  openedDatabases.push(opened);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status
      ) values ('attempt-1', 'issue', 'issue-1', 'implementation', 1, ?, 'config-1',
        'standard', 'model', 'medium', '[]', 'standard', '2026-07-13T10:00:00Z', 'created')
    `)
    .run(owned);
  opened.sqlite
    .prepare(`
      insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', 'issue-1', 'service-1', 'Running', '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', '2026-07-13T10:02:00Z', 'Todo', 'dispatch')
    `)
    .run();
  await beginServiceRun(opened.database, {
    hostId: "host-1",
    id: "run-1",
    serviceVersion: "0.0.0",
    startReason: "startup",
    startedAt: "2026-07-13T10:01:00Z",
    startupConfigSnapshotId: "config-1",
  });
  return { opened, owned, root, stale };
}

describe("startup recovery coordination", () => {
  it("publishes ready only after process and workspace ownership reconcile", async () => {
    const { opened, owned, root, stale } = await fixture();

    const result = await recoverStartupState({
      completedAt: "2026-07-13T10:01:02Z",
      database: opened.database,
      processOwnershipReconciled: true,
      quarantineId: "run-1",
      serviceRunId: "run-1",
      workspaceRoot: root,
    });

    expect(result).toEqual({
      owned: [await real(owned)],
      quarantined: [
        {
          from: path.resolve(stale),
          to: path.join(root, ".quarantine", "run-1", "issue-2"),
        },
      ],
    });
    expect(
      opened.sqlite.prepare("select status from service_runs where id = 'run-1'").get(),
    ).toEqual({ status: "ready" });
    await expect(access(stale)).rejects.toThrow();
  });

  it("does not touch workspaces or publish ready before process ownership reconciliation", async () => {
    const { opened, root, stale } = await fixture();

    await expect(
      recoverStartupState({
        completedAt: "2026-07-13T10:01:02Z",
        database: opened.database,
        processOwnershipReconciled: false,
        quarantineId: "run-1",
        serviceRunId: "run-1",
        workspaceRoot: root,
      }),
    ).rejects.toThrow("recovery.process_ownership_unverified");
    await expect(access(stale)).resolves.toBeUndefined();
    expect(
      opened.sqlite.prepare("select status from service_runs where id = 'run-1'").get(),
    ).toEqual({ status: "recovering" });
  });
});

async function real(value: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(value);
}
