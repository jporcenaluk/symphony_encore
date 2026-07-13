import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMigrations,
  completeInitialBootstrap,
  openDatabase,
} from "../packages/persistence/src/index.ts";

const root = await mkdtemp(path.join(tmpdir(), "symphony-production-smoke-"));
const databasePath = path.join(root, "symphony.sqlite3");
const workspaceRoot = path.join(root, "workspaces");
let child: ChildProcess | undefined;

try {
  await prepareInitializedStore(databasePath);
  const port = await availablePort();
  child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG_LEVEL: "silent",
      SYMPHONY_DATABASE_PATH: databasePath,
      SYMPHONY_PORT: String(port),
      SYMPHONY_UI_ROOT: path.join(process.cwd(), "apps", "web", "dist"),
      SYMPHONY_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const url = await waitForUiUrl(child);
  assert.equal(url, `http://127.0.0.1:${port}`);

  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service_state: "ready", status: "healthy" });
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 200);
  const ui = await fetch(`${url}/operations`, { headers: { accept: "text/html" } });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<div id="root"><\/div>/u);
  assert.match(ui.headers.get("content-security-policy") ?? "", /default-src 'self'/u);

  child.kill("SIGTERM");
  const [exitCode, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
  child = undefined;

  const reopened = openDatabase(databasePath);
  const stopped = reopened.sqlite
    .prepare("select status, end_reason from service_runs order by started_at desc limit 1")
    .get();
  assert.deepEqual(stopped, { end_reason: "signal", status: "stopped" });
  await reopened.close();
  process.stdout.write("Production runtime smoke passed\n");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { force: true, recursive: true });
}

async function prepareInitializedStore(databasePath: string) {
  const opened = openDatabase(databasePath);
  try {
    await applyMigrations(opened.database);
    const completed = await completeInitialBootstrap(opened.database, {
      actionId: "runtime-smoke-bootstrap",
      authSubject: "local:smoke",
      candidateHash: "sha256:runtime-smoke",
      confirmedCandidateHash: "sha256:runtime-smoke",
      configSnapshot: {
        acknowledgmentState: { bootstrap: "acknowledged" },
        adapterVersions: { local: "1" },
        createdAt: new Date().toISOString(),
        effectiveConfig: { "server.session_secret": "$SESSION_SECRET" },
        id: "runtime-smoke-snapshot",
        operatorOverrideRevision: 0,
        promptHash: "sha256:runtime-smoke-prompt",
        restartState: {},
        sourceMetadata: {},
        workflowSourceHash: "sha256:runtime-smoke-workflow",
      },
      consumedAt: new Date().toISOString(),
      credential: {
        algorithm: "scrypt",
        parameters: { N: 16_384, keyLength: 32, p: 1, r: 8 },
        salt: Buffer.from("runtime-smoke-salt"),
        verifier: Buffer.from("runtime-smoke-verifier"),
      },
      expectedBootstrapCredentialHash: "sha256:runtime-smoke-bootstrap",
      operatorId: "runtime-smoke-operator",
      presentedBootstrapCredentialHash: "sha256:runtime-smoke-bootstrap",
      trackerLogin: null,
    });
    assert.deepEqual(completed, { kind: "completed" });
  } finally {
    await opened.close();
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForUiUrl(process: ChildProcess): Promise<string> {
  const stdout = process.stdout;
  const stderr = process.stderr;
  assert(stdout && stderr);
  let output = "";
  let errors = "";
  stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime smoke timed out: ${errors}`)), 15_000);
    timer.unref();
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/Symphony Encore UI: (http:\/\/[^\s]+)/u);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    process.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited before readiness: code=${code} signal=${signal} ${errors}`));
    });
  });
}
