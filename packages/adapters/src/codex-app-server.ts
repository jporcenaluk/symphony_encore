import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  type AgentAdapterManifest,
  type AgentErrorCode,
  type AgentEvent,
  validateAgentToolArguments,
} from "@symphony/contracts";

import { validateAgentPreflight } from "./agent-preflight.js";
import type {
  AgentAdapter,
  AgentLaunchRequest,
  AgentPlanSubmissionDecision,
  AgentPreflightRequest,
  AgentPreflightResult,
  AgentSession,
} from "./contracts.js";

interface JsonObject {
  [key: string]: unknown;
}

interface CodexAppServerAdapterOptions {
  manifest: AgentAdapterManifest;
  maximumLineBytes?: number;
  maximumQueuedEvents?: number;
  processExitGraceMs?: number;
  readTimeoutMs?: number;
  stallTimeoutMs?: number;
  turnTimeoutMs?: number;
  now?: () => Date;
  spawnProcess?: CodexSpawnProcess;
}

export type CodexSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface NormalizationContext {
  attemptId: string;
  model: string;
  now: () => Date;
  reasoningEffort: string;
  sessionId: string | null;
  workspacePath: string;
}

const DEFAULT_MAXIMUM_LINE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAXIMUM_QUEUED_EVENTS = 256;
const DEFAULT_PROCESS_EXIT_GRACE_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;

export function createCodexAppServerAdapter(options: CodexAppServerAdapterOptions): AgentAdapter {
  const now = options.now ?? (() => new Date());

  return {
    async launch(request) {
      assertPreflightMatches(request.preflight, options.manifest);
      const workspacePath = await validateWorkspace(request.workspacePath);
      return launchCodexSession(request, workspacePath, options, now);
    },
    async manifest() {
      return options.manifest;
    },
    async preflight(request: AgentPreflightRequest): Promise<AgentPreflightResult> {
      return validateAgentPreflight({
        manifest: options.manifest,
        request,
        resolvedSkills: request.requiredSkills,
      });
    },
  };
}

async function validateWorkspace(workspacePath: string): Promise<string> {
  if (!path.isAbsolute(workspacePath)) throw new AgentStartupError("invalid_workspace_cwd");
  try {
    const resolved = await realpath(workspacePath);
    if (!(await stat(resolved)).isDirectory()) throw new AgentStartupError("invalid_workspace_cwd");
    return resolved;
  } catch (error) {
    if (error instanceof AgentStartupError) throw error;
    throw new AgentStartupError("invalid_workspace_cwd", { cause: error });
  }
}

function assertPreflightMatches(
  preflight: AgentPreflightResult,
  manifest: AgentAdapterManifest,
): void {
  if (
    preflight.adapterVersion !== manifest.adapter_version ||
    preflight.protocolSchemaHash !== manifest.protocol.schema_hash
  ) {
    throw new AgentStartupError("protocol_incompatible");
  }
}

async function launchCodexSession(
  request: AgentLaunchRequest,
  workspacePath: string,
  options: CodexAppServerAdapterOptions,
  now: () => Date,
): Promise<AgentSession> {
  const child = (options.spawnProcess ?? spawn)("bash", ["-c", request.command], {
    cwd: workspacePath,
    detached: true,
    env: { ...request.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForSpawn(child);
  if (child.pid === undefined) throw new AgentStartupError("agent_not_found");
  const processId = child.pid;

  const queue = new AsyncEventQueue<AgentEvent>(
    options.maximumQueuedEvents ?? DEFAULT_MAXIMUM_QUEUED_EVENTS,
    () => void shutdown(),
  );
  const exit = waitForChildExit(child);
  const pending = new Map<
    string,
    {
      method: string;
      reject(error: Error): void;
      resolve(result: unknown): void;
      timer: NodeJS.Timeout;
    }
  >();
  const profile = request.preflight.manifest.profiles[request.profile];
  const context: NormalizationContext = {
    attemptId: request.attemptId,
    model: profile.model,
    now,
    reasoningEffort: profile.reasoning_effort,
    sessionId: null,
    workspacePath,
  };
  const earlyEvents: AgentEvent[] = [];
  let sessionEstablished = false;
  let nextRequestId = 1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let shuttingDown = false;
  let turnTimer: NodeJS.Timeout | undefined;
  let stallTimer: NodeJS.Timeout | undefined;

  const emitEvent = (event: AgentEvent) => {
    if (sessionEstablished) queue.push(event);
    else earlyEvents.push(event);
  };

  const failSession = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    queue.fail(error);
    void shutdown();
  };

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      queue.push(startupOrTurnFailure(context, threadId, "stalled"));
      void shutdown();
    }, options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
  };

  const send = (message: JsonObject) => {
    if (child.stdin.destroyed) throw new Error("agent transport is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const requestResponse = (method: string, params: unknown): Promise<unknown> => {
    const id = nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new AgentStartupError("response_timeout"));
      }, options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
      pending.set(String(id), { method, reject, resolve, timer });
    });
    try {
      send({ id, method, params });
    } catch (error) {
      const waiter = pending.get(String(id));
      if (waiter) clearTimeout(waiter.timer);
      pending.delete(String(id));
      return Promise.reject(error);
    }
    return response;
  };

  const respond = (id: string | number, result: unknown) => send({ id, result });

  const handleMessage = (message: unknown) => {
    resetStallTimer();
    if (!isObject(message)) {
      emitEvent(malformedEvent(context, "non_object_message"));
      return;
    }
    if ("id" in message && !("method" in message)) {
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(String(message.id));
      if (isObject(message.error)) {
        waiter.reject(new Error(String(message.error.message ?? "app-server request failed")));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") {
      emitEvent(malformedEvent(context, "missing_method"));
      return;
    }
    if ("id" in message) {
      void handleServerRequest(
        message,
        respond,
        emitEvent,
        context,
        request.preflight,
        request.onPlanSubmitted,
      ).catch(failSession);
      return;
    }
    const event = normalizeNotification(message.method, message.params, context);
    if (event) emitEvent(event);
    if (message.method === "turn/completed") {
      if (turnTimer) clearTimeout(turnTimer);
      void shutdown();
    }
  };

  readJsonLines(
    child,
    options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES,
    handleMessage,
    failSession,
  );
  child.stderr.resume();
  exit.then(({ code, signal }) => {
    if (stallTimer) clearTimeout(stallTimer);
    if (turnTimer) clearTimeout(turnTimer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(
          `agent process exited while awaiting ${request.method}: code=${String(code)} signal=${String(signal)}`,
        ),
      );
    }
    pending.clear();
    queue.close();
  });

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (stallTimer) clearTimeout(stallTimer);
    if (turnTimer) clearTimeout(turnTimer);
    child.stdin.end();
    const graceMs = options.processExitGraceMs ?? DEFAULT_PROCESS_EXIT_GRACE_MS;
    const ended = await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (ended) return;
    killProcessGroup(processId, "SIGTERM");
    const terminated = await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!terminated) killProcessGroup(processId, "SIGKILL");
    await exit;
  }

  const session: AgentSession = {
    async cancel(reason) {
      if (threadId && turnId && !shuttingDown) {
        try {
          await requestResponse("turn/interrupt", { threadId, turnId, reason });
        } catch {
          // Process-group shutdown remains authoritative when interruption fails.
        }
      }
      await shutdown();
    },
    events: queue,
    processGroupId: processId,
    processId,
    waitForExit: () => exit,
  };

  try {
    await requestResponse("initialize", {
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
      clientInfo: { name: "symphony-encore", title: "Symphony Encore", version: "0.0.0" },
    });
    const tools = [
      dynamicTool(
        "report_result",
        `Report the terminal result for the ${request.preflight.role} role.`,
        request.preflight.terminalResultSchema,
      ),
    ];
    if (request.preflight.submitPlanSchema) {
      tools.push(
        dynamicTool(
          "submit_plan",
          "Submit or replace the implementation plan for this attempt.",
          request.preflight.submitPlanSchema,
        ),
      );
    }
    const thread = asObject(
      await requestResponse("thread/start", {
        approvalPolicy: "never",
        cwd: workspacePath,
        dynamicTools: tools,
        ephemeral: true,
        model: profile.model,
        runtimeWorkspaceRoots: [workspacePath],
        sandbox: "workspace-write",
      }),
      "thread/start response",
    );
    threadId = requiredString(asObject(thread.thread, "thread").id, "thread.id");
    await requestResponse("thread/name/set", { name: request.title, threadId });
    const turn = asObject(
      await requestResponse("turn/start", {
        cwd: workspacePath,
        effort: profile.reasoning_effort,
        input: [
          { text: request.prompt, text_elements: [], type: "text" },
          ...request.preflight.resolvedSkills.map((skill) => ({
            name: skill.name,
            path: skill.resolvedPath,
            type: "skill",
          })),
        ],
        model: profile.model,
        runtimeWorkspaceRoots: [workspacePath],
        threadId,
      }),
      "turn/start response",
    );
    turnId = requiredString(asObject(turn.turn, "turn").id, "turn.id");
    context.sessionId = `${threadId}-${turnId}`;
    queue.push({
      ...commonEvent(context),
      event: "session_started",
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      thread_id: threadId,
      turn_id: turnId,
    });
    sessionEstablished = true;
    for (const event of earlyEvents.splice(0)) {
      queue.push({ ...event, session_id: context.sessionId } as AgentEvent);
    }
    turnTimer = setTimeout(() => {
      queue.push(startupOrTurnFailure(context, threadId, "turn_timeout"));
      void shutdown();
    }, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    resetStallTimer();
  } catch (error) {
    const code = error instanceof AgentStartupError ? error.code : "protocol_incompatible";
    queue.push({ ...commonEvent(context), error_code: code, event: "startup_failed" });
    void shutdown();
  }

  return session;
}

function dynamicTool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
) {
  return { description, inputSchema, name, type: "function" };
}

async function handleServerRequest(
  message: JsonObject,
  respond: (id: string | number, result: unknown) => void,
  emitEvent: (event: AgentEvent) => void,
  context: NormalizationContext,
  preflight: AgentPreflightResult,
  onPlanSubmitted?: (plan: unknown) => Promise<AgentPlanSubmissionDecision>,
): Promise<void> {
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  const method = String(message.method);
  const params = isObject(message.params) ? message.params : {};
  if (method === "item/tool/call") {
    const tool = typeof params.tool === "string" ? params.tool : "unknown";
    const schema =
      tool === "report_result"
        ? preflight.terminalResultSchema
        : tool === "submit_plan"
          ? preflight.submitPlanSchema
          : null;
    if (!schema || !validateAgentToolArguments(schema, params.arguments)) {
      emitEvent({ ...commonEvent(context), event: "unsupported_tool_call", tool_name: tool });
      respond(id, {
        contentItems: [
          {
            text: schema ? "Arguments failed schema validation." : "Unsupported tool.",
            type: "inputText",
          },
        ],
        success: false,
      });
      return;
    }
    if (tool === "report_result") {
      emitEvent({
        ...commonEvent(context),
        event: "terminal_result_reported",
        result: params.arguments,
      });
    } else {
      emitEvent({
        ...commonEvent(context),
        event: "plan_reported",
        plan: params.arguments,
      });
      if (onPlanSubmitted) {
        const decision = await onPlanSubmitted(params.arguments);
        if (typeof decision.accepted !== "boolean" || !decision.message) {
          throw new Error("agent Plan decision is invalid");
        }
        respond(id, {
          contentItems: [{ text: decision.message, type: "inputText" }],
          success: decision.accepted,
        });
        return;
      }
    }
    respond(id, {
      contentItems: [{ text: `${tool} accepted.`, type: "inputText" }],
      success: true,
    });
    return;
  }
  respond(id, {
    error: { code: -32601, message: `Unsupported server request: ${method}` },
  });
}

function normalizeNotification(
  method: string,
  rawParams: unknown,
  context: NormalizationContext,
): AgentEvent | null {
  const params = isObject(rawParams) ? rawParams : {};
  if (method === "thread/tokenUsage/updated") {
    const total = asObject(asObject(params.tokenUsage, "tokenUsage").total, "tokenUsage.total");
    return {
      ...commonEvent(context),
      billable_categories: {
        cached_input_tokens: nonNegativeNumber(total.cachedInputTokens),
        reasoning_output_tokens: nonNegativeNumber(total.reasoningOutputTokens),
      },
      cost_usd: null,
      event: "token_usage",
      input_tokens: nonNegativeInteger(total.inputTokens),
      output_tokens: nonNegativeInteger(total.outputTokens),
      total_tokens: nonNegativeInteger(total.totalTokens),
    };
  }
  if (method === "account/rateLimits/updated") {
    return { ...commonEvent(context), event: "rate_limit", snapshot: params };
  }
  if (method === "item/started" || method === "item/completed") {
    return normalizeItem(method, params, context);
  }
  if (method === "turn/completed") {
    const turn = asObject(params.turn, "turn");
    const status = String(turn.status ?? "failed");
    const event =
      status === "completed"
        ? "turn_completed"
        : status === "interrupted"
          ? "turn_cancelled"
          : "turn_failed";
    const error = isObject(turn.error) ? turn.error.message : null;
    return {
      ...commonEvent(context),
      event,
      provider_reason: typeof error === "string" && error.length > 0 ? error : status,
    };
  }
  if (method === "item/tool/requestUserInput") {
    return {
      ...commonEvent(context),
      event: "turn_input_required",
      provider_reason: "Codex requested user input.",
    };
  }
  if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta) {
    return { ...commonEvent(context), event: "notification", message: params.delta };
  }
  if (method === "error") {
    const error = isObject(params.error) ? params.error.message : null;
    return {
      ...commonEvent(context),
      event: "notification",
      message: typeof error === "string" && error ? error : "Codex reported an error.",
    };
  }
  return null;
}

function normalizeItem(
  method: "item/completed" | "item/started",
  params: JsonObject,
  context: NormalizationContext,
): AgentEvent | null {
  const item = asObject(params.item, "item");
  const id = requiredString(item.id, "item.id");
  const type = requiredString(item.type, "item.type");
  const completed = method === "item/completed";
  let kind: "command" | "file_change" | "network_fetch" | "other" | "tool_call";
  let summary: string;
  let cwd = context.workspacePath;
  if (type === "commandExecution") {
    kind = "command";
    summary = requiredString(item.command, "item.command");
    if (typeof item.cwd === "string" && item.cwd) cwd = item.cwd;
  } else if (type === "fileChange") {
    kind = "file_change";
    summary = "Workspace file change";
  } else if (type === "webSearch") {
    kind = "network_fetch";
    summary = "Web search";
  } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
    kind = "tool_call";
    summary = typeof item.tool === "string" && item.tool ? item.tool : type;
  } else {
    return null;
  }
  const status =
    typeof item.status === "string" ? item.status : completed ? "completed" : "inProgress";
  const failed = completed && ["declined", "failed"].includes(status);
  return {
    ...commonEvent(context),
    action_id: id,
    cwd,
    event: failed ? "action_failed" : completed ? "action_completed" : "action_started",
    exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
    kind,
    output_ref: null,
    result_status: completed ? status : null,
    summary,
  };
}

function readJsonLines(
  child: ChildProcessWithoutNullStreams,
  maximumLineBytes: number,
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void,
): void {
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > maximumLineBytes) {
        onError(new Error("agent protocol line exceeds maximum size"));
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onMessage(null);
      }
    }
    if (buffer.byteLength > maximumLineBytes)
      onError(new Error("agent protocol line exceeds maximum size"));
  });
  child.stdout.on("error", onError);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) =>
      reject(new AgentStartupError("agent_not_found", { cause: error })),
    );
  });
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    // `exit` may fire before stdout is drained. `close` guarantees the protocol
    // stream has ended, so terminal notifications cannot race queue shutdown.
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function startupOrTurnFailure(
  context: NormalizationContext,
  threadId: string | null,
  errorCode: "stalled" | "turn_timeout",
): AgentEvent {
  if (!threadId) return { ...commonEvent(context), error_code: errorCode, event: "startup_failed" };
  return { ...commonEvent(context), event: "turn_failed", provider_reason: errorCode };
}

function malformedEvent(context: NormalizationContext, messageRef: string): AgentEvent {
  return { ...commonEvent(context), event: "malformed", message_ref: messageRef };
}

function commonEvent(context: NormalizationContext) {
  return {
    attempt_id: context.attemptId,
    session_id: context.sessionId,
    timestamp: context.now().toISOString(),
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`invalid ${label}`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid ${label}`);
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

class AgentStartupError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "AgentStartupError";
    this.code = code;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<{
    reject(error: Error): void;
    resolve(result: IteratorResult<T>): void;
  }> = [];
  private closed = false;
  private error: Error | null = null;
  private readonly maximumSize: number;
  private readonly onOverflow: () => void;

  constructor(maximumSize: number, onOverflow: () => void) {
    if (!Number.isInteger(maximumSize) || maximumSize < 1)
      throw new Error("invalid event queue size");
    this.maximumSize = maximumSize;
    this.onOverflow = onOverflow;
  }

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value });
      return;
    }
    if (this.values.length >= this.maximumSize) {
      this.fail(new Error("agent event queue overflow"));
      this.onOverflow();
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.readers.push({ reject, resolve }));
      },
    };
  }
}
