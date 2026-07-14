import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashLocalPassword } from "@symphony/adapters";
import {
  applyMigrations,
  createOperatorIdentity,
  type OpenedDatabase,
  openDatabase,
} from "@symphony/persistence";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalSessionAuth } from "./local-session-auth.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-session-auth-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
  await applyMigrations(opened.database);
  await createOperatorIdentity(opened.database, {
    authSubject: "local:admin",
    capabilities: ["operator.read", "config.write"],
    createdAt: "2026-07-13T10:00:00.000Z",
    credential: await hashLocalPassword("correct horse battery staple"),
    id: "operator-1",
    trackerLogin: null,
  });
  return {
    auth: createLocalSessionAuth({
      database: opened.database,
      now: () => new Date("2026-07-13T10:30:00.000Z"),
      sessionTtlMs: 3_600_000,
    }),
    opened,
  };
}

describe("local session authentication", () => {
  it("issues opaque secrets after password verification and authenticates only their cookie hash", async () => {
    const { auth, opened } = await fixture();

    await expect(
      auth.login({ authSubject: "local:admin", password: "wrong password" }),
    ).resolves.toBeNull();
    const login = await auth.login({
      authSubject: "local:admin",
      password: "correct horse battery staple",
    });
    expect(login).toMatchObject({
      expiresAt: "2026-07-13T11:30:00.000Z",
      principal: {
        authSubject: "local:admin",
        capabilities: ["config.write", "operator.read"],
        operatorId: "operator-1",
      },
    });
    expect(login?.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(login?.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);

    const row = opened.sqlite
      .prepare("select token_hash, csrf_token_hash from operator_sessions")
      .get() as { csrf_token_hash: string; token_hash: string };
    expect(row.token_hash).not.toContain(login?.sessionToken);
    expect(row.csrf_token_hash).not.toContain(login?.csrfToken);

    const request = {
      headers: { cookie: `other=x; symphony_session=${login?.sessionToken}; theme=dark` },
    } as FastifyRequest;
    await expect(auth.authenticate(request)).resolves.toEqual(login?.principal);
    await expect(
      auth.authenticate({ headers: { cookie: "symphony_session=invalid" } } as FastifyRequest),
    ).resolves.toBeNull();
  });

  it("binds CSRF verification and same-origin enforcement to the authenticated session", async () => {
    const { auth } = await fixture();
    const login = await auth.login({
      authSubject: "local:admin",
      password: "correct horse battery staple",
    });
    const request = (csrf: string, origin = "http://127.0.0.1:8080") =>
      ({
        headers: {
          cookie: `symphony_session=${login?.sessionToken}`,
          host: "127.0.0.1:8080",
          origin,
          "x-csrf-token": csrf,
        },
        protocol: "http",
      }) as unknown as FastifyRequest;

    await expect(auth.authenticateMutation(request(login?.csrfToken ?? ""))).resolves.toEqual(
      login?.principal,
    );
    await expect(auth.authenticateMutation(request("wrong"))).resolves.toBeNull();
    await expect(
      auth.authenticateMutation(request(login?.csrfToken ?? "", "https://attacker.example")),
    ).resolves.toBeNull();
  });
});
