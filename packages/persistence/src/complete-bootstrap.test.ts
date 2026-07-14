import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeInitialBootstrap, type InitialBootstrapRequest } from "./complete-bootstrap.js";
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

function request(overrides: Partial<InitialBootstrapRequest> = {}): InitialBootstrapRequest {
  return {
    actionId: "action-bootstrap-1",
    authSubject: "local:admin",
    candidateHash: "sha256:candidate",
    confirmedCandidateHash: "sha256:candidate",
    configSnapshot: {
      acknowledgmentState: { bootstrap: "acknowledged" },
      adapterVersions: { local: "1" },
      createdAt: "2026-07-13T10:00:00Z",
      effectiveConfig: { "server.session_secret": "$SESSION_SECRET" },
      id: "snapshot-bootstrap-1",
      operatorOverrideRevision: 0,
      promptHash: "sha256:prompt",
      restartState: {},
      sourceMetadata: {},
      workflowSourceHash: "sha256:workflow",
    },
    consumedAt: "2026-07-13T10:00:00Z",
    credential: {
      algorithm: "scrypt",
      parameters: { N: 16384, keyLength: 32, p: 1, r: 8 },
      salt: Buffer.from("salt"),
      verifier: Buffer.from("verifier"),
    },
    expectedBootstrapCredentialHash: "sha256:bootstrap",
    operatorId: "operator-1",
    presentedBootstrapCredentialHash: "sha256:bootstrap",
    trackerLogin: "admin",
    ...overrides,
  };
}

describe("initial bootstrap transaction", () => {
  it("atomically creates the first administrator, acknowledged config, and audit action", async () => {
    const opened = await database();

    await expect(completeInitialBootstrap(opened.database, request())).resolves.toEqual({
      kind: "completed",
    });
    expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select count(*) as count from config_snapshots").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select action, result from operator_actions").get()).toEqual({
      action: "bootstrap.complete",
      result: "accepted",
    });
    expect(opened.sqlite.prepare("select candidate_hash from bootstrap_state").get()).toEqual({
      candidate_hash: "sha256:candidate",
    });
    expect(
      opened.sqlite
        .prepare(
          "select key, version, operation, acknowledgment_state, reload_state from configuration_overrides",
        )
        .get(),
    ).toEqual({
      acknowledgment_state: "acknowledged",
      key: "human.operators",
      operation: "set",
      reload_state: "active",
      version: 1,
    });
    expect(
      opened.sqlite
        .prepare("select count(*) as count from sqlite_schema where sql like '%sha256:bootstrap%'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed on either credential or exact-candidate mismatch without durable state", async () => {
    for (const invalid of [
      request({ presentedBootstrapCredentialHash: "sha256:wrong" }),
      request({ confirmedCandidateHash: "sha256:near-miss" }),
    ]) {
      const opened = await database();
      await expect(completeInitialBootstrap(opened.database, invalid)).resolves.toEqual({
        kind:
          invalid.presentedBootstrapCredentialHash === "sha256:wrong"
            ? "credential_mismatch"
            : "candidate_mismatch",
      });
      expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
        count: 0,
      });
      expect(opened.sqlite.prepare("select count(*) as count from config_snapshots").get()).toEqual(
        {
          count: 0,
        },
      );
    }
  });

  it("cannot be reused and rolls every record back when snapshot validation fails", async () => {
    const opened = await database();
    await expect(
      completeInitialBootstrap(
        opened.database,
        request({
          configSnapshot: {
            ...request().configSnapshot,
            effectiveConfig: { "server.session_secret": "literal-secret" },
          },
        }),
      ),
    ).rejects.toThrow("Configuration snapshot contains a literal secret");
    expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
      count: 0,
    });

    await expect(completeInitialBootstrap(opened.database, request())).resolves.toEqual({
      kind: "completed",
    });
    await expect(completeInitialBootstrap(opened.database, request())).resolves.toEqual({
      kind: "already_initialized",
    });
    expect(opened.sqlite.prepare("select count(*) as count from bootstrap_state").get()).toEqual({
      count: 1,
    });
  });
});
