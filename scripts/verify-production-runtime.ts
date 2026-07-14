import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/persistence/src/index.ts";
import { waitForHttpReady } from "./runtime-readiness.ts";

const root = await mkdtemp(path.join(tmpdir(), "symphony-production-smoke-"));
const databasePath = path.join(root, "symphony.sqlite3");
const workspaceRoot = path.join(root, "workspaces");
const workflowPath = path.join(root, "WORKFLOW.md");
const bootstrapCredential = "synthetic-bootstrap-credential";
const operatorPassword = "synthetic operator password";
let child: ChildProcess | undefined;

try {
  const port = await availablePort();
  await writeFile(
    workflowPath,
    `---
agent:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
server:
  auth_kind: local
  port: ${port}
tracker:
  kind: github
  owner: synthetic
  project_number: 1
  repo_owner: synthetic
  repo_name: synthetic
workspace:
  root: ${JSON.stringify(workspaceRoot)}
  verify_command: make verify
---
Complete {{ issue.title }}.
`,
  );
  child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG_LEVEL: "silent",
      SYMPHONY_BOOTSTRAP_AUTH_SUBJECT: "local:smoke",
      SYMPHONY_BOOTSTRAP_CREDENTIAL: bootstrapCredential,
      SYMPHONY_DATABASE_PATH: databasePath,
      SYMPHONY_PORT: String(port),
      SYMPHONY_UI_ROOT: path.join(process.cwd(), "apps", "web", "dist"),
      SYMPHONY_WORKFLOW_PATH: workflowPath,
      SYMPHONY_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const startup = await waitForStartup(child, true);
  const { url } = startup;
  assert.equal(url, `http://127.0.0.1:${port}`);
  assert.match(startup.candidateHash ?? "", /^sha256:[a-f0-9]{64}$/u);

  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service_state: "starting", status: "healthy" });
  let ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 503);
  const bootstrapStatus = await fetch(`${url}/api/v1/bootstrap`);
  assert.equal(bootstrapStatus.status, 200);
  assert.deepEqual(await bootstrapStatus.json(), {
    candidate_hash: startup.candidateHash,
    status: "required",
  });
  const completed = await fetch(`${url}/api/v1/bootstrap`, {
    body: JSON.stringify({
      auth_subject: "local:smoke",
      bootstrap_credential: bootstrapCredential,
      confirmed_candidate_hash: startup.candidateHash,
      password: operatorPassword,
      tracker_login: null,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { status: "completed" });
  assert.equal((await fetch(`${url}/api/v1/bootstrap`)).status, 404);
  ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 200);
  const login = await fetch(`${url}/api/v1/auth/login`, {
    body: JSON.stringify({ auth_subject: "local:smoke", password: operatorPassword }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(login.status, 200);
  assert.equal(
    ((await login.json()) as { operator: { operator_id: string } }).operator.operator_id,
    "bootstrap-admin",
  );
  const ui = await fetch(`${url}/operations`, { headers: { accept: "text/html" } });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<div id="root"><\/div>/u);
  assert.match(ui.headers.get("content-security-policy") ?? "", /default-src 'self'/u);

  child.kill("SIGTERM");
  const [exitCode, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
  child = undefined;

  child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG_LEVEL: "silent",
      SYMPHONY_DATABASE_PATH: databasePath,
      SYMPHONY_PORT: String(port),
      SYMPHONY_UI_ROOT: path.join(process.cwd(), "apps", "web", "dist"),
      SYMPHONY_WORKFLOW_PATH: workflowPath,
      SYMPHONY_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const restartedClosed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const restarted = await waitForStartup(child, false);
  assert.equal(restarted.url, url);
  await waitForHttpReady(url);
  assert.equal((await fetch(`${url}/api/v1/bootstrap`)).status, 404);
  child.kill("SIGTERM");
  const [restartExitCode, restartSignal] = await restartedClosed;
  assert.equal(restartSignal, null);
  assert.equal(restartExitCode, 0);
  child = undefined;

  const reopened = openDatabase(databasePath);
  const stopped = reopened.sqlite
    .prepare("select status, end_reason from service_runs order by started_at")
    .all();
  assert.deepEqual(stopped, [
    { end_reason: "signal", status: "stopped" },
    { end_reason: "signal", status: "stopped" },
  ]);
  await reopened.close();
  process.stdout.write("Production runtime smoke passed\n");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { force: true, recursive: true });
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

async function waitForStartup(
  process: ChildProcess,
  requireCandidate: boolean,
): Promise<{ candidateHash?: string; url: string }> {
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
      const url = output.match(/Symphony Encore UI: (http:\/\/[^\s]+)/u)?.[1];
      const candidateHash = output.match(/Bootstrap candidate: (sha256:[a-f0-9]{64})/u)?.[1];
      if (url && (!requireCandidate || candidateHash)) {
        clearTimeout(timer);
        resolve(candidateHash ? { candidateHash, url } : { url });
      }
    });
    process.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited before readiness: code=${code} signal=${signal} ${errors}`));
    });
  });
}
