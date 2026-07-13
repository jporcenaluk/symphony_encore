import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, completeInitialBootstrap, openDatabase } from "@symphony/persistence";
import { describe, expect, it, vi } from "vitest";

import { startProductionService } from "./service-runtime.js";
import type { WorkflowFileMonitorInput } from "./workflow-file-monitor.js";

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
    let workflowMonitorInput: WorkflowFileMonitorInput | undefined;
    const service = await startProductionService({
      hostId: "host-1",
      listen,
      now: (() => {
        const times = ["2026-07-13T10:01:00Z", "2026-07-13T10:01:01Z", "2026-07-13T10:02:00Z"];
        return () => times.shift() ?? "2026-07-13T10:02:00Z";
      })(),
      options: {
        allowNonLoopback: false,
        databasePath: fixture.databasePath,
        host: "127.0.0.1",
        port: 8080,
        secureCookies: false,
        sessionTtlMs: 60_000,
        uiRoot: fixture.uiRoot,
        workflowPath: path.join(fixture.root, "WORKFLOW.md"),
        workspaceRoot: fixture.workspaceRoot,
      },
      output: () => undefined,
      serviceRunId: () => "service-run-1",
      startupConfiguration: {
        environment: {},
        home: rootHome(fixture.root),
        systemTemp: path.join(fixture.root, "tmp"),
        workflow: {
          config: {
            agent: {
              approval_policy: "on-request",
              thread_sandbox: "workspace-write",
              turn_sandbox_policy: "workspace-write",
            },
            server: { auth_kind: "local" },
            tracker: {
              kind: "github",
              owner: "example",
              project_number: 1,
              repo_name: "repo",
              repo_owner: "example",
            },
            workspace: { root: fixture.workspaceRoot, verify_command: "make verify" },
          },
          path: path.join(fixture.root, "WORKFLOW.md"),
          prompt: "Complete {{ issue.title }}.",
          sourceHash: "sha256:startup-workflow",
          warnings: [],
        },
      },
      workflowMonitorFactory(monitorInput) {
        workflowMonitorInput = monitorInput;
        return { check: async () => undefined, close: async () => undefined };
      },
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

    if (!workflowMonitorInput) throw new Error("test.workflow_monitor_missing");
    await workflowMonitorInput.onCandidate({
      source: `---
agent:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
server:
  auth_kind: local
  port: 9090
tracker:
  kind: github
  owner: example
  project_number: 1
  repo_name: repo
  repo_owner: example
workspace:
  root: ${fixture.workspaceRoot}
  verify_command: make verify
---
Updated prompt for {{ issue.title }}.
`,
      sourceHash: "sha256:live-workflow",
    });
    await workflowMonitorInput.onCandidate({
      source: "---\ntracker: [\n---\nBroken",
      sourceHash: "sha256:invalid-workflow",
    });

    await service.close();
    const reopened = openDatabase(fixture.databasePath);
    expect(
      reopened.sqlite
        .prepare("select status, end_reason from service_runs where id = ?")
        .get("service-run-1"),
    ).toEqual({ end_reason: "signal", status: "stopped" });
    expect(reopened.sqlite.prepare("select count(*) as count from config_snapshots").get()).toEqual(
      {
        count: 3,
      },
    );
    const latest = reopened.sqlite
      .prepare(
        "select effective_config_json, restart_state_json from config_snapshots order by rowid desc limit 1",
      )
      .get() as { effective_config_json: string; restart_state_json: string };
    expect(JSON.parse(latest.effective_config_json)["server.port"]).toBe(8080);
    expect(JSON.parse(latest.restart_state_json)["server.port"]).toBe("pending_restart");
    expect(
      reopened.sqlite.prepare("select event_name, result from event_records order by cursor").all(),
    ).toEqual([
      { event_name: "workflow.reload", result: "accepted" },
      { event_name: "workflow.reload", result: "rejected" },
    ]);
    await reopened.close();
  });

  it("keeps a pristine store loopback-only until exact bootstrap completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-pristine-"));
    const uiRoot = path.join(root, "ui");
    await mkdir(uiRoot);
    await writeFile(path.join(uiRoot, "index.html"), "<!doctype html>");
    const databasePath = path.join(root, "symphony.sqlite3");
    const output: string[] = [];
    const service = await startProductionService({
      bootstrap: {
        authSubject: "local:admin",
        candidateHash: "sha256:runtime-candidate",
        configSnapshot: {
          acknowledgmentState: { bootstrap: "acknowledged" },
          adapterVersions: { local: "1" },
          createdAt: "2026-07-13T10:00:00Z",
          effectiveConfig: {
            "human.operators": [
              {
                auth_subject: "local:admin",
                capabilities: ["operator.read", "config.write", "config.ack"],
                id: "bootstrap-admin",
                tracker_login: null,
              },
            ],
            "server.session_secret": "$SESSION_SECRET",
          },
          id: "bootstrap-snapshot",
          operatorOverrideRevision: 0,
          promptHash: "sha256:prompt",
          restartState: {},
          sourceMetadata: {},
          workflowSourceHash: "sha256:workflow",
        },
        credentialHash: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
        operatorId: "bootstrap-admin",
      },
      listen: async () => "http://127.0.0.1:48081",
      now: () => "2026-07-13T10:00:00Z",
      options: {
        allowNonLoopback: false,
        databasePath,
        host: "127.0.0.1",
        port: 8080,
        secureCookies: false,
        sessionTtlMs: 60_000,
        uiRoot,
        workflowPath: path.join(root, "WORKFLOW.md"),
        workspaceRoot: path.join(root, "workspaces"),
      },
      output: (line) => output.push(line),
      serviceRunId: () => "bootstrap-run",
    });
    expect(output).toContain("Bootstrap candidate: sha256:runtime-candidate");
    expect((await service.server.inject({ url: "/api/v1/bootstrap" })).statusCode).toBe(200);
    expect((await service.server.inject({ url: "/ready" })).statusCode).toBe(503);

    const completed = await service.server.inject({
      method: "POST",
      payload: {
        auth_subject: "local:admin",
        bootstrap_credential: "foo",
        confirmed_candidate_hash: "sha256:runtime-candidate",
        password: "a strong local password",
        tracker_login: null,
      },
      url: "/api/v1/bootstrap",
    });
    expect(completed.statusCode).toBe(200);
    expect((await service.server.inject({ url: "/api/v1/bootstrap" })).statusCode).toBe(404);
    expect((await service.server.inject({ url: "/ready" })).statusCode).toBe(200);
    await service.close();

    const opened = openDatabase(databasePath);
    expect(opened.sqlite.prepare("select count(*) as count from operators").get()).toEqual({
      count: 1,
    });
    expect(opened.sqlite.prepare("select status from service_runs").get()).toEqual({
      status: "stopped",
    });
    await opened.close();
  });

  it("requires an explicit secure deployment acknowledgment for a persisted remote bind", async () => {
    const fixture = await initializedFixture();
    const opened = openDatabase(fixture.databasePath);
    const snapshot = opened.sqlite
      .prepare("select effective_config_json from config_snapshots limit 1")
      .get() as { effective_config_json: string };
    const effectiveConfig = JSON.parse(snapshot.effective_config_json) as Record<string, unknown>;
    effectiveConfig["server.host"] = "0.0.0.0";
    opened.sqlite
      .prepare("update config_snapshots set effective_config_json = ?")
      .run(JSON.stringify(effectiveConfig));
    await opened.close();

    await expect(
      startProductionService({
        listen: vi.fn(async () => "http://0.0.0.0:8080"),
        options: {
          allowNonLoopback: false,
          databasePath: fixture.databasePath,
          host: "127.0.0.1",
          port: 8080,
          secureCookies: false,
          sessionTtlMs: 60_000,
          uiRoot: fixture.uiRoot,
          workflowPath: path.join(fixture.root, "WORKFLOW.md"),
          workspaceRoot: fixture.workspaceRoot,
        },
      }),
    ).rejects.toThrow("runtime.non_loopback_ack_required");
  });

  it("records operator-store corruption before failing closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-corrupt-runtime-"));
    const databasePath = path.join(root, "symphony.sqlite3");
    const opened = openDatabase(databasePath);
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    await opened.close();

    await expect(
      startProductionService({
        now: () => "2026-07-13T10:00:00Z",
        options: {
          allowNonLoopback: false,
          databasePath,
          host: "127.0.0.1",
          port: 8080,
          secureCookies: false,
          sessionTtlMs: 60_000,
          uiRoot: path.join(root, "ui"),
          workflowPath: path.join(root, "WORKFLOW.md"),
          workspaceRoot: path.join(root, "workspaces"),
        },
      }),
    ).rejects.toThrow("runtime.operator_store_missing_nonpristine");

    const reopened = openDatabase(databasePath);
    expect(reopened.sqlite.prepare("select reason_code from startup_failures").get()).toEqual({
      reason_code: "operator_store_missing_nonpristine",
    });
    await reopened.close();
  });
});

function rootHome(root: string): string {
  return path.join(root, "home");
}
