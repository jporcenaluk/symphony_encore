import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, completeInitialBootstrap, openDatabase } from "@symphony/persistence";
import { describe, expect, it, vi } from "vitest";

import { startProductionService } from "./service-runtime.js";

async function initializedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-service-"));
  const uiRoot = path.join(root, "ui");
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(uiRoot);
  await writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>production UI</main>");
  const databasePath = path.join(root, "state", "symphony.sqlite3");
  await mkdir(path.dirname(databasePath));
  const opened = openDatabase(databasePath);
  await applyMigrations(opened.database);
  await completeInitialBootstrap(opened.database, {
    actionId: "bootstrap-action-1",
    authSubject: "local:admin",
    candidateHash: "sha256:candidate",
    confirmedCandidateHash: "sha256:candidate",
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
    consumedAt: "2026-07-13T10:00:00Z",
    credential: {
      algorithm: "scrypt",
      parameters: { N: 16_384, keyLength: 32, p: 1, r: 8 },
      salt: Buffer.from("salt"),
      verifier: Buffer.from("verifier"),
    },
    expectedBootstrapCredentialHash: "sha256:bootstrap",
    operatorId: "operator-1",
    presentedBootstrapCredentialHash: "sha256:bootstrap",
    trackerLogin: "admin",
  });
  await opened.close();
  return { databasePath, root, uiRoot, workspaceRoot };
}

describe("production service lifecycle", () => {
  it("opens an initialized store, recovers before readiness, and closes durably", async () => {
    const fixture = await initializedFixture();
    const listen = vi.fn(async () => "http://127.0.0.1:48080");
    const service = await startProductionService({
      hostId: "host-1",
      listen,
      now: (() => {
        const times = ["2026-07-13T10:01:00Z", "2026-07-13T10:01:01Z", "2026-07-13T10:02:00Z"];
        return () => times.shift() ?? "2026-07-13T10:02:00Z";
      })(),
      options: {
        databasePath: fixture.databasePath,
        host: "127.0.0.1",
        port: 8080,
        secureCookies: false,
        sessionTtlMs: 60_000,
        uiRoot: fixture.uiRoot,
        workspaceRoot: fixture.workspaceRoot,
      },
      output: () => undefined,
      serviceRunId: () => "service-run-1",
    });

    expect(listen).toHaveBeenCalledOnce();
    expect((await service.server.inject({ url: "/health" })).json()).toEqual({
      service_state: "ready",
      status: "healthy",
    });
    expect((await service.server.inject({ url: "/ready" })).json()).toEqual({
      service_run_id: "service-run-1",
      status: "ready",
    });
    expect(
      (await service.server.inject({ headers: { accept: "text/html" }, url: "/operations" })).body,
    ).toContain("production UI");

    await service.close();
    const reopened = openDatabase(fixture.databasePath);
    expect(
      reopened.sqlite
        .prepare("select status, end_reason from service_runs where id = ?")
        .get("service-run-1"),
    ).toEqual({ end_reason: "signal", status: "stopped" });
    await reopened.close();
  });

  it("does not create authority or service state in a pristine store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-pristine-"));
    const uiRoot = path.join(root, "ui");
    await mkdir(uiRoot);
    await writeFile(path.join(uiRoot, "index.html"), "<!doctype html>");
    await expect(
      startProductionService({
        options: {
          databasePath: path.join(root, "symphony.sqlite3"),
          host: "127.0.0.1",
          port: 8080,
          secureCookies: false,
          sessionTtlMs: 60_000,
          uiRoot,
          workspaceRoot: path.join(root, "workspaces"),
        },
      }),
    ).rejects.toThrow("runtime.bootstrap_required");
    const opened = openDatabase(path.join(root, "symphony.sqlite3"));
    expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select count(*) as count from service_runs").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });
});
