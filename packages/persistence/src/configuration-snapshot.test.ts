import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigurationSnapshot, storeConfigurationSnapshot } from "./configuration-snapshot.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

const openedDatabases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});

describe("configuration snapshots", () => {
  it("persists immutable effective values and source metadata across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-snapshot-"));
    directories.push(directory);
    const filename = path.join(directory, "symphony.sqlite3");
    let opened = openDatabase(filename);
    await applyMigrations(opened.database);
    await storeConfigurationSnapshot(opened.database, {
      acknowledgmentState: { "tracker.kind": "acknowledged" },
      adapterVersions: { codex: "1.0.0", github: "2026-01-01" },
      createdAt: "2026-07-13T10:00:00Z",
      effectiveConfig: {
        "polling.interval_ms": 5_000,
        "server.session_secret": "$SESSION_SECRET",
      },
      id: "snapshot-1",
      operatorOverrideRevision: 3,
      promptHash: "sha256:prompt",
      restartState: { "server.host": "active" },
      sourceMetadata: { "polling.interval_ms": { source: "operator_override", version: 3 } },
      workflowSourceHash: "sha256:workflow",
    });
    await opened.close();

    opened = openDatabase(filename);
    openedDatabases.push(opened);
    await applyMigrations(opened.database);
    expect(await loadConfigurationSnapshot(opened.database, "snapshot-1")).toEqual({
      acknowledgmentState: { "tracker.kind": "acknowledged" },
      adapterVersions: { codex: "1.0.0", github: "2026-01-01" },
      createdAt: "2026-07-13T10:00:00Z",
      effectiveConfig: {
        "polling.interval_ms": 5_000,
        "server.session_secret": "$SESSION_SECRET",
      },
      id: "snapshot-1",
      operatorOverrideRevision: 3,
      promptHash: "sha256:prompt",
      restartState: { "server.host": "active" },
      sourceMetadata: { "polling.interval_ms": { source: "operator_override", version: 3 } },
      workflowSourceHash: "sha256:workflow",
    });
  });

  it("rejects resolved secret material before it reaches SQLite", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-snapshot-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    openedDatabases.push(opened);
    await applyMigrations(opened.database);

    await expect(
      storeConfigurationSnapshot(opened.database, {
        acknowledgmentState: {},
        adapterVersions: {},
        createdAt: "2026-07-13T10:00:00Z",
        effectiveConfig: { "server.session_secret": "resolved-secret" },
        id: "snapshot-invalid",
        operatorOverrideRevision: 0,
        promptHash: "sha256:prompt",
        restartState: {},
        sourceMetadata: {},
        workflowSourceHash: "sha256:workflow",
      }),
    ).rejects.toThrow("Configuration snapshot contains a literal secret at server.session_secret");
    expect(opened.sqlite.prepare("select count(*) as count from config_snapshots").get()).toEqual({
      count: 0,
    });
  });
});
