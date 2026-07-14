import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { appendEventRecord, listEventRecords, streamEventRecords } from "./event-store.js";
import { beginServiceRun } from "./service-run-store.js";

const openedDatabases: OpenedDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<{ filename: string; opened: OpenedDatabase }> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-events-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "symphony.sqlite3");
  const opened = openDatabase(filename);
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
  return { filename, opened };
}

function event(id: string, timestamp: string) {
  return {
    attemptId: null,
    changeClass: null,
    computeProfile: null,
    costUsd: null,
    eventName: "service.recovery",
    id,
    payload: { phase: id },
    reasonCode: "recovery.progress",
    result: "recorded",
    serviceRunId: "run-1",
    timestamp,
    workRef: null,
  } as const;
}

describe("append-only event store", () => {
  it("assigns monotonic durable cursors and resumes strictly after a cursor", async () => {
    const { opened } = await fixture();
    await expect(
      appendEventRecord(opened.database, event("event-1", "2026-07-13T10:00:01Z")),
    ).resolves.toMatchObject({ cursor: 1, id: "event-1" });
    await appendEventRecord(opened.database, event("event-2", "2026-07-13T10:00:02Z"));
    await appendEventRecord(opened.database, event("event-3", "2026-07-13T10:00:03Z"));

    await expect(listEventRecords(opened.database, { afterCursor: 1, limit: 1 })).resolves.toEqual({
      hasMore: true,
      items: [
        {
          attempt_id: null,
          change_class: null,
          compute_profile: null,
          cost_usd: null,
          cursor: 2,
          event_name: "service.recovery",
          id: "event-2",
          payload: { phase: "event-2" },
          reason_code: "recovery.progress",
          result: "recorded",
          service_run_id: "run-1",
          timestamp: "2026-07-13T10:00:02Z",
          work_ref: null,
        },
      ],
      nextCursor: 2,
    });
  });

  it("preserves cursor replay across database restart", async () => {
    const { filename, opened } = await fixture();
    await appendEventRecord(opened.database, event("event-1", "2026-07-13T10:00:01Z"));
    await opened.close();
    openedDatabases.splice(openedDatabases.indexOf(opened), 1);

    const restarted = openDatabase(filename);
    openedDatabases.push(restarted);
    await appendEventRecord(restarted.database, event("event-2", "2026-07-13T10:00:02Z"));
    const page = await listEventRecords(restarted.database, { afterCursor: 1, limit: 10 });
    expect(page.items.map((item) => item.cursor)).toEqual([2]);
    expect(page.nextCursor).toBe(2);
  });

  it("rejects unbounded page sizes", async () => {
    const { opened } = await fixture();
    await expect(
      listEventRecords(opened.database, { afterCursor: 0, limit: 1001 }),
    ).rejects.toThrow("events.invalid_limit");
  });

  it("follows new durable cursors and stops promptly when aborted", async () => {
    const { opened } = await fixture();
    await appendEventRecord(opened.database, event("event-1", "2026-07-13T10:00:01Z"));
    const controller = new AbortController();
    let waited = false;
    const seen: number[] = [];

    for await (const record of streamEventRecords(opened.database, {
      afterCursor: 0,
      batchSize: 10,
      pollIntervalMs: 1,
      signal: controller.signal,
      async wait() {
        waited = true;
        await appendEventRecord(opened.database, event("event-2", "2026-07-13T10:00:02Z"));
      },
    })) {
      seen.push(record.cursor);
      if (record.cursor === 2) controller.abort();
    }

    expect(waited).toBe(true);
    expect(seen).toEqual([1, 2]);
  });
});
