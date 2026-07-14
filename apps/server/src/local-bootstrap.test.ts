import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { describe, expect, it, vi } from "vitest";

import { createLocalBootstrap } from "./local-bootstrap.js";

describe("local first-run bootstrap", () => {
  it("hashes credentials, commits exact authority once, and disables itself", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-local-bootstrap-"));
    const opened = openDatabase(path.join(root, "symphony.sqlite3"));
    await applyMigrations(opened.database);
    const afterCompleted = vi.fn(async () => undefined);
    const bootstrap = createLocalBootstrap({
      afterCompleted,
      authSubject: "local:admin",
      candidateHash: "sha256:candidate",
      configSnapshot: {
        acknowledgmentState: { bootstrap: "acknowledged" },
        adapterVersions: { local: "1" },
        createdAt: "2026-07-13T10:00:00Z",
        effectiveConfig: { "server.session_secret": "$SESSION_SECRET" },
        id: "snapshot-1",
        operatorOverrideRevision: 0,
        promptHash: "sha256:prompt",
        restartState: {},
        sourceMetadata: {},
        workflowSourceHash: "sha256:workflow",
      },
      database: opened.database,
      expectedCredentialHash: sha256("one-time"),
      newActionId: () => "action-1",
      now: () => "2026-07-13T10:00:00Z",
      operatorId: "bootstrap-admin",
    });

    await expect(bootstrap.status()).resolves.toEqual({
      candidateHash: "sha256:candidate",
      kind: "required",
    });
    await expect(
      bootstrap.complete({
        authSubject: "local:admin",
        bootstrapCredential: "wrong",
        confirmedCandidateHash: "sha256:candidate",
        password: "a strong local password",
        trackerLogin: null,
      }),
    ).resolves.toEqual({ kind: "credential_mismatch" });
    expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
      count: 0,
    });

    await expect(
      bootstrap.complete({
        authSubject: "local:admin",
        bootstrapCredential: "one-time",
        confirmedCandidateHash: "sha256:candidate",
        password: "a strong local password",
        trackerLogin: null,
      }),
    ).resolves.toEqual({ kind: "completed" });
    await expect(bootstrap.status()).resolves.toEqual({ kind: "disabled" });
    expect(afterCompleted).toHaveBeenCalledOnce();
    expect(opened.sqlite.prepare("select id, auth_subject from operators").get()).toEqual({
      auth_subject: "local:admin",
      id: "bootstrap-admin",
    });
    const stored = opened.sqlite
      .prepare("select verifier from local_operator_credentials")
      .get() as { verifier: Buffer };
    expect(stored.verifier.toString("utf8")).not.toContain("a strong local password");
    await opened.close();
  });
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
