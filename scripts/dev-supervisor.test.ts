import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { superviseDevelopmentProcesses } from "./dev-supervisor.js";

class FakeChild extends EventEmitter {
  readonly kills: NodeJS.Signals[] = [];
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function fixture() {
  const children = [new FakeChild(101), new FakeChild(102)];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const spawnProcess = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions) =>
      children.shift() as unknown as ChildProcess,
  );
  return { children, handlers, spawnProcess };
}

describe("development process supervisor", () => {
  it("keeps both processes together and forwards termination signals", async () => {
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const handlers = new Map<NodeJS.Signals, () => void>();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    const result = superviseDevelopmentProcesses({
      registerSignal: (signal, handler) => handlers.set(signal, handler),
      removeSignal: (signal) => handlers.delete(signal),
      signalChild: (child, signal) => child.kill(signal),
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    handlers.get("SIGTERM")?.();

    await expect(result).resolves.toBe(143);
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(second.kills).toEqual(["SIGTERM"]);
  });

  it("returns failure and stops the sibling when either required process exits", async () => {
    const first = new FakeChild(201);
    const second = new FakeChild(202);
    const { handlers, spawnProcess } = fixture();
    spawnProcess.mockReset();
    spawnProcess
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    const result = superviseDevelopmentProcesses({
      registerSignal: (signal, handler) => handlers.set(signal, handler),
      removeSignal: (signal) => handlers.delete(signal),
      signalChild: (child, signal) => child.kill(signal),
      spawnProcess,
    });

    first.emit("close", 0, null);

    await expect(result).resolves.toBe(1);
    expect(second.kills).toEqual(["SIGTERM"]);
  });
});
