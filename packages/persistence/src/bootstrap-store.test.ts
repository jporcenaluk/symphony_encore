import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectBootstrapEligibility } from "./bootstrap-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function database(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-bootstrap-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
  await applyMigrations(opened.database);
  return opened;
}

describe("bootstrap eligibility", () => {
  it("permits bootstrap only when every domain table is pristine", async () => {
    const opened = await database();
    await expect(inspectBootstrapEligibility(opened.database)).resolves.toEqual({
      kind: "pristine",
    });
  });

  it("classifies an operator-empty non-pristine store as recovery corruption", async () => {
    const opened = await database();
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");

    await expect(inspectBootstrapEligibility(opened.database)).resolves.toEqual({
      kind: "operator_store_missing_nonpristine",
      populatedTables: ["config_snapshots"],
    });
  });

  it("recognizes an initialized operator store without offering bootstrap", async () => {
    const opened = await database();
    opened.sqlite
      .prepare(`
        insert into operators (
          id, auth_subject, capabilities_json, status, version, created_at, updated_at
        ) values ('operator-1', 'local:admin', '["operator.read"]', 'active', 1, 't0', 't0')
      `)
      .run();

    await expect(inspectBootstrapEligibility(opened.database)).resolves.toEqual({
      kind: "initialized",
      operatorCount: 1,
    });
  });
});
