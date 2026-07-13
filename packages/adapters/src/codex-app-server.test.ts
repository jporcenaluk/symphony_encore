import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { AgentAdapterManifest, AgentEvent } from "@symphony/contracts";
import { describe, expect, it } from "vitest";
import type { CodexSpawnProcess } from "./codex-app-server.js";
import { createCodexAppServerAdapter } from "./codex-app-server.js";
import type { AgentLaunchRequest, AgentPreflightResult } from "./contracts.js";

const manifest: AgentAdapterManifest = {
  adapter_version: "codex-test",
  capabilities: ["terminal_result", "submit_plan", "skills"],
  price_table: null,
  profiles: {
    deep: { model: "gpt-test", reasoning_effort: "high" },
    economy: { model: "gpt-test", reasoning_effort: "low" },
    standard: { model: "gpt-test", reasoning_effort: "medium" },
  },
  protocol: { maximum: "2", minimum: "2", schema_hash: "sha256:test" },
};

const terminalResultSchema = {
  additionalProperties: false,
  properties: { outcome: { const: "success" } },
  required: ["outcome"],
  type: "object",
} as const;

function preflight(): AgentPreflightResult {
  return {
    adapterVersion: manifest.adapter_version,
    manifest,
    protocolSchemaHash: manifest.protocol.schema_hash,
    resolvedSkills: [
      {
        contentHash: "sha256:skill",
        name: "implementation",
        resolvedPath: "/skills/implementation/SKILL.md",
      },
    ],
    role: "implementation",
    submitPlanSchema: {
      additionalProperties: false,
      properties: { markdown: { type: "string" } },
      required: ["markdown"],
      type: "object",
    },
    terminalResultSchema,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

type ProtocolHandler = (
  message: Record<string, unknown>,
  control: {
    close(code?: number, signal?: NodeJS.Signals | null): void;
    send(message: unknown): void;
  },
) => void;

function scriptedProcess(handler: ProtocolHandler): CodexSpawnProcess {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      stdin: PassThrough;
      stdout: PassThrough;
    };
    child.pid = 91_001;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let buffer = "";
    let closed = false;
    const control = {
      close(code = 0, signal: NodeJS.Signals | null = null) {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit("close", code, signal));
      },
      send(message: unknown) {
        child.stdout.write(`${JSON.stringify(message)}\n`);
      },
    };
    child.stdin.on("finish", () => control.close());
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handler(JSON.parse(line) as Record<string, unknown>, control);
      }
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as CodexSpawnProcess;
}

function request(overrides?: Partial<AgentLaunchRequest>): AgentLaunchRequest {
  return {
    attemptId: "attempt-1",
    command: "codex app-server",
    environment: {},
    preflight: preflight(),
    profile: "standard",
    prompt: "Do the work",
    title: "ISSUE-1: Test adapter",
    workspacePath: process.cwd(),
    ...overrides,
  };
}

describe("Codex app-server adapter", () => {
  it("handshakes before the turn, exposes typed tools and skills, and normalizes the session", async () => {
    const spawnProcess = scriptedProcess((message, control) => {
      const params = message.params as Record<string, unknown>;
      if (message.method === "initialize") {
        expect(params).toMatchObject({ capabilities: { experimentalApi: true } });
        control.send({
          id: message.id,
          result: {
            codexHome: "/tmp",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "codex-test",
          },
        });
      } else if (message.method === "thread/start") {
        const names = (params.dynamicTools as Array<{ name: string }>)
          .map((tool) => tool.name)
          .sort();
        expect(names).toEqual(["report_result", "submit_plan"]);
        expect(params).toMatchObject({ cwd: process.cwd(), model: "gpt-test" });
        control.send({
          id: message.id,
          result: { model: "gpt-test", reasoningEffort: "medium", thread: { id: "thread-1" } },
        });
      } else if (message.method === "thread/name/set") {
        expect(params).toEqual({ name: "ISSUE-1: Test adapter", threadId: "thread-1" });
        control.send({ id: message.id, result: {} });
      } else if (message.method === "turn/start") {
        expect(params).toMatchObject({ effort: "medium", model: "gpt-test" });
        expect(params.input).toEqual([
          { text: "Do the work", text_elements: [], type: "text" },
          { name: "implementation", path: "/skills/implementation/SKILL.md", type: "skill" },
        ]);
        control.send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
        control.send({
          method: "item/started",
          params: {
            item: {
              aggregatedOutput: null,
              command: "pnpm test",
              commandActions: [],
              cwd: process.cwd(),
              durationMs: null,
              exitCode: null,
              id: "action-1",
              processId: null,
              source: "agent",
              status: "inProgress",
              type: "commandExecution",
            },
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
        control.send({
          method: "item/completed",
          params: {
            completedAtMs: 2,
            item: {
              aggregatedOutput: "ok",
              command: "pnpm test",
              commandActions: [],
              cwd: process.cwd(),
              durationMs: 1,
              exitCode: 0,
              id: "action-1",
              processId: null,
              source: "agent",
              status: "completed",
              type: "commandExecution",
            },
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
        control.send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last: {
                cachedInputTokens: 0,
                inputTokens: 1,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: 2,
              },
              modelContextWindow: 100,
              total: {
                cachedInputTokens: 2,
                inputTokens: 8,
                outputTokens: 4,
                reasoningOutputTokens: 1,
                totalTokens: 12,
              },
            },
            turnId: "turn-1",
          },
        });
        control.send({
          id: "tool-1",
          method: "item/tool/call",
          params: {
            arguments: { outcome: "success" },
            callId: "call-1",
            namespace: null,
            threadId: "thread-1",
            tool: "report_result",
            turnId: "turn-1",
          },
        });
      } else if (message.id === "tool-1") {
        expect(message.result).toMatchObject({ success: true });
        control.send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { error: null, id: "turn-1", status: "completed" },
          },
        });
        control.close();
      }
    });
    const adapter = createCodexAppServerAdapter({ manifest, readTimeoutMs: 1_000, spawnProcess });

    const session = await adapter.launch(request());
    const events = await collect(session.events);

    expect(events.map((event) => event.event)).toEqual([
      "session_started",
      "action_started",
      "action_completed",
      "token_usage",
      "terminal_result_reported",
      "turn_completed",
    ]);
    expect(events[0]).toMatchObject({
      attempt_id: "attempt-1",
      model: "gpt-test",
      reasoning_effort: "medium",
      session_id: "thread-1-turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    expect(events[3]).toMatchObject({
      cost_usd: null,
      input_tokens: 8,
      output_tokens: 4,
      total_tokens: 12,
    });
    expect(events[4]).toMatchObject({ result: { outcome: "success" } });
    await expect(session.waitForExit()).resolves.toEqual({ code: 0, signal: null });
  });

  it("rejects invalid results and returns unsupported tools without stalling", async () => {
    const spawnProcess = scriptedProcess((message, control) => {
      if (message.method === "initialize") {
        control.send({ id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        control.send({ id: message.id, result: { thread: { id: "thread-2" } } });
      } else if (message.method === "thread/name/set") {
        control.send({ id: message.id, result: {} });
      } else if (message.method === "turn/start") {
        control.send({ id: message.id, result: { turn: { id: "turn-2" } } });
        control.send({
          id: "bad-result",
          method: "item/tool/call",
          params: { arguments: { outcome: "wrong" }, tool: "report_result" },
        });
      } else if (message.id === "bad-result") {
        expect(message.result).toMatchObject({ success: false });
        control.send({
          id: "unknown",
          method: "item/tool/call",
          params: { arguments: {}, tool: "publish_pr" },
        });
      } else if (message.id === "unknown") {
        expect(message.result).toMatchObject({ success: false });
        control.send({
          method: "turn/completed",
          params: {
            threadId: "thread-2",
            turn: { error: { message: "no result" }, id: "turn-2", status: "failed" },
          },
        });
        control.close();
      }
    });
    const adapter = createCodexAppServerAdapter({ manifest, readTimeoutMs: 1_000, spawnProcess });
    const session = await adapter.launch(
      request({
        attemptId: "attempt-2",
        preflight: { ...preflight(), submitPlanSchema: null },
        profile: "economy",
        prompt: "Try",
      }),
    );

    const events = await collect(session.events);
    expect(events.map((event) => event.event)).toEqual([
      "session_started",
      "unsupported_tool_call",
      "unsupported_tool_call",
      "turn_failed",
    ]);
    expect(events[0]).toMatchObject({ reasoning_effort: "low" });
  });

  it("terminates the session when the bounded event queue overflows", async () => {
    const spawnProcess = scriptedProcess((message, control) => {
      if (message.method === "initialize") control.send({ id: message.id, result: {} });
      else if (message.method === "thread/start") {
        control.send({ id: message.id, result: { thread: { id: "thread-overflow" } } });
      } else if (message.method === "thread/name/set") {
        control.send({ id: message.id, result: {} });
      } else if (message.method === "turn/start") {
        control.send({ id: message.id, result: { turn: { id: "turn-overflow" } } });
        control.send({
          method: "item/agentMessage/delta",
          params: { delta: "one", threadId: "thread-overflow", turnId: "turn-overflow" },
        });
        control.send({
          method: "item/agentMessage/delta",
          params: { delta: "two", threadId: "thread-overflow", turnId: "turn-overflow" },
        });
      }
    });
    const adapter = createCodexAppServerAdapter({
      manifest,
      maximumQueuedEvents: 1,
      processExitGraceMs: 10,
      spawnProcess,
    });
    const session = await adapter.launch(request());

    await expect(collect(session.events)).rejects.toThrow("agent event queue overflow");
    await expect(
      Promise.race([
        session.waitForExit(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("session remained live")), 50),
        ),
      ]),
    ).resolves.toEqual({ code: 0, signal: null });
  });
});
