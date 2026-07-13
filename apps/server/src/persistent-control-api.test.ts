import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEventRecord,
  applyMigrations,
  beginServiceRun,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { type ControlApi, createPersistentControlApi } from "./persistent-control-api.js";

const openedDatabases: OpenedDatabase[] = [];
const servers: ControlApi[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("persistent Control API composition", () => {
  it("serves the durable ServiceRun projection without an in-memory mirror", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-persistent-api-"));
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
    const server = await createPersistentControlApi({
      async authenticate() {
        return {
          authSubject: "subject-1",
          capabilities: ["operator.read"],
          operatorId: "operator-1",
        };
      },
      database: opened.database,
      async login() {
        return null;
      },
      sessionCookieSecure: false,
    });
    servers.push(server);
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api/v1/state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dispatch_enabled: false,
      service_run: { id: "run-1", status: "recovering" },
      version: "service-run:run-1:recovering",
    });

    await appendEventRecord(opened.database, {
      attemptId: null,
      changeClass: null,
      computeProfile: null,
      costUsd: null,
      eventName: "service.recovery",
      id: "event-1",
      payload: { phase: "workspaces" },
      reasonCode: "recovery.progress",
      result: "recorded",
      serviceRunId: "run-1",
      timestamp: "2026-07-13T10:00:01Z",
      workRef: null,
    });
    const events = await server.inject({
      method: "GET",
      url: "/api/v1/events?after_cursor=0&limit=10",
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({
      has_more: false,
      items: [{ cursor: 1, id: "event-1" }],
      next_cursor: 1,
    });
  });
});
