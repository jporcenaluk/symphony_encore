import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { createHash } from "node:crypto";

import type { AgentAdapterManifest } from "@symphony/contracts";

import type { CodexSpawnProcess } from "./codex-app-server.js";

interface JsonObject {
  [key: string]: unknown;
}

interface CatalogModel {
  defaultReasoningEffort: string;
  hidden: boolean;
  id: string;
  isDefault: boolean;
  model: string;
  supportedReasoningEfforts: string[];
}

export interface CodexManifestDiscoveryOptions {
  command: string;
  cwd?: string;
  environment: Readonly<Record<string, string | undefined>>;
  maximumLineBytes?: number;
  processExitGraceMs?: number;
  readTimeoutMs?: number;
  spawnProcess?: CodexSpawnProcess;
}

const DEFAULT_MAXIMUM_LINE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PROCESS_EXIT_GRACE_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

const CODEX_APP_SERVER_V2_PROTOCOL_SHAPE = {
  requests: {
    initialize: ["capabilities", "clientInfo"],
    modelList: ["cursor", "includeHidden", "limit"],
    threadStart: ["cwd", "dynamicTools", "model", "sandbox"],
    turnStart: ["effort", "input", "model", "threadId"],
  },
  responses: {
    initialize: ["userAgent"],
    modelList: [
      "data[].defaultReasoningEffort",
      "data[].hidden",
      "data[].id",
      "data[].isDefault",
      "data[].model",
      "data[].supportedReasoningEfforts[].reasoningEffort",
      "nextCursor",
    ],
  },
  version: 2,
} as const;

export const CODEX_APP_SERVER_V2_SCHEMA_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify(CODEX_APP_SERVER_V2_PROTOCOL_SHAPE))
  .digest("hex")}`;

export async function discoverCodexAppServerManifest(
  options: CodexManifestDiscoveryOptions,
): Promise<AgentAdapterManifest> {
  if (!options.command.trim()) throw new Error("agent_manifest.command_empty");
  const child = (options.spawnProcess ?? spawn)("bash", ["-c", options.command], {
    cwd: options.cwd ?? process.cwd(),
    detached: true,
    env: { ...options.environment },
    stdio: ["pipe", "pipe", "pipe"],
  } satisfies SpawnOptionsWithoutStdio);
  const transport = await openDiscoveryTransport(child, options);
  try {
    const initialized = asObject(
      await transport.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "symphony-encore", title: "Symphony Encore", version: "0.0.0" },
      }),
      "agent_manifest.initialize_invalid",
    );
    const userAgent = requiredString(
      initialized.userAgent,
      "agent_manifest.initialize_user_agent_invalid",
    );
    const models = await fetchModelCatalog(transport);
    const defaultModels = models.filter((model) => model.isDefault && !model.hidden);
    if (defaultModels.length !== 1) throw new Error("agent_manifest.default_model_invalid");
    const selected = defaultModels[0];
    if (!selected) throw new Error("agent_manifest.default_model_invalid");
    const efforts = selected.supportedReasoningEfforts;
    const defaultEffort = selected.defaultReasoningEffort;
    if (!efforts.includes(defaultEffort)) {
      throw new Error("agent_manifest.default_reasoning_effort_invalid");
    }

    return {
      adapter_version: `codex-app-server-v2:${userAgent}`,
      capabilities: ["terminal_result", "submit_plan", "skills"],
      price_table: null,
      profiles: {
        deep: { model: selected.model, reasoning_effort: efforts.at(-1) ?? defaultEffort },
        economy: { model: selected.model, reasoning_effort: efforts[0] ?? defaultEffort },
        standard: { model: selected.model, reasoning_effort: defaultEffort },
      },
      protocol: {
        maximum: "2",
        minimum: "2",
        schema_hash: CODEX_APP_SERVER_V2_SCHEMA_HASH,
      },
    };
  } finally {
    await transport.close();
  }
}

interface DiscoveryTransport {
  close(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

async function openDiscoveryTransport(
  child: ChildProcessWithoutNullStreams,
  options: CodexManifestDiscoveryOptions,
): Promise<DiscoveryTransport> {
  const exit = waitForChildExit(child);
  await waitForSpawn(child);
  if (child.pid === undefined) throw new Error("agent_manifest.process_id_missing");
  const processId = child.pid;
  const maximumLineBytes = options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const pending = new Map<
    string,
    { reject(error: Error): void; resolve(result: unknown): void; timer: NodeJS.Timeout }
  >();
  let buffer = Buffer.alloc(0);
  let nextRequestId = 1;
  let closed = false;

  const failPending = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > maximumLineBytes) {
        failPending(new Error("agent_manifest.protocol_line_too_large"));
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        failPending(new Error("agent_manifest.protocol_json_invalid"));
        return;
      }
      if (!isObject(message) || !("id" in message) || "method" in message) continue;
      const waiter = pending.get(String(message.id));
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(String(message.id));
      if (isObject(message.error)) {
        waiter.reject(
          new Error(`agent_manifest.protocol_error:${String(message.error.message ?? "unknown")}`),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
    if (buffer.byteLength > maximumLineBytes) {
      failPending(new Error("agent_manifest.protocol_line_too_large"));
    }
  });
  child.stdout.on("error", (error) => failPending(error));
  child.stdin.on("error", (error) => failPending(error));
  child.stderr.resume();
  exit.then(({ code, signal }) => {
    closed = true;
    failPending(
      new Error(`agent_manifest.process_exited:code=${String(code)}:signal=${String(signal)}`),
    );
  });

  return {
    async close() {
      if (closed) return;
      child.stdin.end();
      const graceMs = options.processExitGraceMs ?? DEFAULT_PROCESS_EXIT_GRACE_MS;
      if (await resolvesWithin(exit, graceMs)) return;
      killProcessGroup(processId, "SIGTERM");
      if (await resolvesWithin(exit, graceMs)) return;
      killProcessGroup(processId, "SIGKILL");
      await exit;
    },
    request(method, params) {
      if (closed || child.stdin.destroyed) {
        return Promise.reject(new Error("agent_manifest.transport_closed"));
      }
      const id = nextRequestId++;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`agent_manifest.response_timeout:${method}`));
        }, readTimeoutMs);
        pending.set(String(id), { reject, resolve, timer });
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return response;
    },
  };
}

async function fetchModelCatalog(transport: DiscoveryTransport): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  const modelIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = asObject(
      await transport.request("model/list", { cursor, includeHidden: false, limit: 100 }),
      "agent_manifest.model_page_invalid",
    );
    if (!Array.isArray(page.data)) throw new Error("agent_manifest.model_page_invalid");
    for (const value of page.data) {
      const model = parseCatalogModel(value);
      if (modelIds.has(model.id)) throw new Error("agent_manifest.model_duplicate");
      modelIds.add(model.id);
      models.push(model);
    }
    if (page.nextCursor === null) break;
    const nextCursor = requiredString(page.nextCursor, "agent_manifest.pagination_cursor_invalid");
    if (seenCursors.has(nextCursor)) throw new Error("agent_manifest.pagination_cycle");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return models;
}

function parseCatalogModel(value: unknown): CatalogModel {
  const model = asObject(value, "agent_manifest.model_invalid");
  if (typeof model.hidden !== "boolean" || typeof model.isDefault !== "boolean") {
    throw new Error("agent_manifest.model_invalid");
  }
  if (!Array.isArray(model.supportedReasoningEfforts)) {
    throw new Error("agent_manifest.reasoning_efforts_invalid");
  }
  const supportedReasoningEfforts = model.supportedReasoningEfforts.map((value) =>
    requiredString(
      asObject(value, "agent_manifest.reasoning_effort_invalid").reasoningEffort,
      "agent_manifest.reasoning_effort_invalid",
    ),
  );
  if (
    supportedReasoningEfforts.length === 0 ||
    new Set(supportedReasoningEfforts).size !== supportedReasoningEfforts.length
  ) {
    throw new Error("agent_manifest.reasoning_efforts_invalid");
  }
  return {
    defaultReasoningEffort: requiredString(
      model.defaultReasoningEffort,
      "agent_manifest.default_reasoning_effort_invalid",
    ),
    hidden: model.hidden,
    id: requiredString(model.id, "agent_manifest.model_id_invalid"),
    isDefault: model.isDefault,
    model: requiredString(model.model, "agent_manifest.model_name_invalid"),
    supportedReasoningEfforts,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown, errorCode: string): JsonObject {
  if (!isObject(value)) throw new Error(errorCode);
  return value;
}

function requiredString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(errorCode);
  return value;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("agent_manifest.agent_not_found")));
  });
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
