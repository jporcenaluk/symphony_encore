import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CodexSpawnProcess } from "./codex-app-server.js";
import {
  CODEX_APP_SERVER_V2_SCHEMA_HASH,
  discoverCodexAppServerManifest,
} from "./codex-manifest.js";

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
    child.pid = 92_001;
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

function model(overrides: Record<string, unknown> = {}) {
  return {
    defaultReasoningEffort: "medium",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    supportedReasoningEfforts: [
      { description: "Fast", reasoningEffort: "low" },
      { description: "Balanced", reasoningEffort: "medium" },
      { description: "Thorough", reasoningEffort: "high" },
    ],
    ...overrides,
  };
}

describe("Codex app-server manifest discovery", () => {
  it("paginates the live catalog and maps logical profiles from the default visible model", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const spawnProcess = scriptedProcess((message, control) => {
      requests.push(message);
      if (message.method === "initialize") {
        control.send({
          id: message.id,
          result: {
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "codex-cli/1.2.3",
          },
        });
      } else if (message.method === "model/list") {
        const params = message.params as Record<string, unknown>;
        if (params.cursor === null) {
          control.send({
            id: message.id,
            result: {
              data: [
                model({ hidden: true, id: "gpt-hidden", isDefault: false, model: "gpt-hidden" }),
              ],
              nextCursor: "page-2",
            },
          });
        } else {
          control.send({ id: message.id, result: { data: [model()], nextCursor: null } });
        }
      }
    });

    await expect(
      discoverCodexAppServerManifest({
        command: "codex app-server",
        environment: {},
        readTimeoutMs: 1_000,
        spawnProcess,
      }),
    ).resolves.toEqual({
      adapter_version: "codex-app-server-v2:codex-cli/1.2.3",
      capabilities: ["terminal_result", "submit_plan", "skills"],
      price_table: null,
      profiles: {
        deep: { model: "gpt-test", reasoning_effort: "high" },
        economy: { model: "gpt-test", reasoning_effort: "low" },
        standard: { model: "gpt-test", reasoning_effort: "medium" },
      },
      protocol: {
        maximum: "2",
        minimum: "2",
        schema_hash: CODEX_APP_SERVER_V2_SCHEMA_HASH,
      },
    });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "model/list",
      "model/list",
    ]);
    expect(requests[1]?.params).toEqual({ cursor: null, includeHidden: false, limit: 100 });
    expect(requests[2]?.params).toEqual({
      cursor: "page-2",
      includeHidden: false,
      limit: 100,
    });
    expect(CODEX_APP_SERVER_V2_SCHEMA_HASH).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("fails closed when the catalog does not have one valid default visible model", async () => {
    const spawnProcess = scriptedProcess((message, control) => {
      if (message.method === "initialize") {
        control.send({
          id: message.id,
          result: {
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "codex-cli/1.2.3",
          },
        });
      } else if (message.method === "model/list") {
        control.send({
          id: message.id,
          result: { data: [model({ isDefault: false })], nextCursor: null },
        });
      }
    });

    await expect(
      discoverCodexAppServerManifest({
        command: "codex app-server",
        environment: {},
        readTimeoutMs: 1_000,
        spawnProcess,
      }),
    ).rejects.toThrow("agent_manifest.default_model_invalid");
  });

  it("rejects repeated cursors instead of accepting a partial catalog", async () => {
    const spawnProcess = scriptedProcess((message, control) => {
      if (message.method === "initialize") {
        control.send({
          id: message.id,
          result: {
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "codex-cli/1.2.3",
          },
        });
      } else if (message.method === "model/list") {
        control.send({ id: message.id, result: { data: [], nextCursor: "repeat" } });
      }
    });

    await expect(
      discoverCodexAppServerManifest({
        command: "codex app-server",
        environment: {},
        readTimeoutMs: 1_000,
        spawnProcess,
      }),
    ).rejects.toThrow("agent_manifest.pagination_cycle");
  });
});
