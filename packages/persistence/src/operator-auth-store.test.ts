import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import {
  authenticateOperatorSession,
  createOperatorIdentity,
  createOperatorSession,
  loadLocalCredentialBySubject,
} from "./operator-auth-store.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function database(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-operator-auth-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
  await applyMigrations(opened.database);
  return opened;
}

describe("operator identity and sessions", () => {
  it("round-trips only a salted local verifier for an immutable auth subject", async () => {
    const opened = await database();
    await createOperatorIdentity(opened.database, {
      authSubject: "local:admin",
      capabilities: ["operator.read", "config.write"],
      createdAt: "2026-07-13T10:00:00Z",
      credential: {
        algorithm: "scrypt",
        parameters: { N: 16384, keyLength: 32, p: 1, r: 8 },
        salt: Buffer.from("salt"),
        verifier: Buffer.from("verifier"),
      },
      id: "operator-1",
      trackerLogin: null,
    });

    await expect(loadLocalCredentialBySubject(opened.database, "local:admin")).resolves.toEqual({
      algorithm: "scrypt",
      capabilities: ["config.write", "operator.read"],
      operatorId: "operator-1",
      operatorVersion: 1,
      parameters: { N: 16384, keyLength: 32, p: 1, r: 8 },
      salt: Buffer.from("salt"),
      verifier: Buffer.from("verifier"),
    });
  });

  it("authenticates a hashed session and invalidates it when operator authority changes", async () => {
    const opened = await database();
    await createOperatorIdentity(opened.database, {
      authSubject: "local:admin",
      capabilities: ["operator.read", "config.write"],
      createdAt: "2026-07-13T10:00:00Z",
      credential: {
        algorithm: "scrypt",
        parameters: { N: 16384, keyLength: 32, p: 1, r: 8 },
        salt: Buffer.from("salt"),
        verifier: Buffer.from("verifier"),
      },
      id: "operator-1",
      trackerLogin: null,
    });
    await createOperatorSession(opened.database, {
      authSubject: "local:admin",
      csrfTokenHash: "sha256:csrf",
      expiresAt: "2026-07-13T12:00:00Z",
      issuedAt: "2026-07-13T10:00:00Z",
      operatorId: "operator-1",
      operatorVersion: 1,
      sessionTokenHash: "sha256:session",
    });

    await expect(
      authenticateOperatorSession(opened.database, {
        now: "2026-07-13T10:30:00Z",
        sessionTokenHash: "sha256:session",
      }),
    ).resolves.toEqual({
      authSubject: "local:admin",
      capabilities: ["config.write", "operator.read"],
      csrfTokenHash: "sha256:csrf",
      operatorId: "operator-1",
    });

    opened.sqlite
      .prepare(
        `update operators set capabilities_json = '["operator.read"]', version = 2,
         updated_at = '2026-07-13T10:31:00Z' where id = 'operator-1'`,
      )
      .run();
    await expect(
      authenticateOperatorSession(opened.database, {
        now: "2026-07-13T10:32:00Z",
        sessionTokenHash: "sha256:session",
      }),
    ).resolves.toBeNull();
    expect(opened.sqlite.prepare("select revoked_at from operator_sessions").get()).toEqual({
      revoked_at: "2026-07-13T10:32:00Z",
    });
    expect(
      opened.sqlite.prepare("select token_hash, csrf_token_hash from operator_sessions").get(),
    ).toEqual({ csrf_token_hash: "sha256:csrf", token_hash: "sha256:session" });
  });
});
