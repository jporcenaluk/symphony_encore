import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface DevelopmentProcess {
  args: readonly string[];
  command: string;
  name: string;
}

interface SupervisorDependencies {
  registerSignal?: (signal: ShutdownSignal, handler: () => void) => void;
  removeSignal?: (signal: ShutdownSignal, handler: () => void) => void;
  signalChild?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

export async function superviseDevelopmentProcesses(
  dependencies: SupervisorDependencies = {},
): Promise<number> {
  const root = process.cwd();
  const processes = developmentProcesses(root);
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const signalChild = dependencies.signalChild ?? signalProcessGroup;
  const registerSignal =
    dependencies.registerSignal ?? ((signal, handler) => process.once(signal, handler));
  const removeSignal =
    dependencies.removeSignal ?? ((signal, handler) => process.removeListener(signal, handler));
  const children = processes.map((definition) => {
    process.stderr.write(`[dev] starting ${definition.name}\n`);
    return spawnProcess(definition.command, definition.args, {
      cwd: root,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "inherit",
    });
  });

  return new Promise<number>((resolve) => {
    const closed = new Set<ChildProcess>();
    let exitCode: number | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const signalHandlers = new Map<ShutdownSignal, () => void>();

    const finishIfClosed = () => {
      if (exitCode === undefined || closed.size !== children.length) return;
      if (escalation) clearTimeout(escalation);
      for (const [signal, handler] of signalHandlers) removeSignal(signal, handler);
      resolve(exitCode);
    };

    const stop = (code: number, signal: NodeJS.Signals, completed?: ChildProcess) => {
      if (exitCode !== undefined) return;
      exitCode = code;
      for (const child of children) {
        if (child !== completed && !closed.has(child)) signalChild(child, signal);
      }
      escalation = setTimeout(() => {
        for (const child of children) {
          if (!closed.has(child)) signalChild(child, "SIGKILL");
        }
      }, 5_000);
      escalation.unref();
      finishIfClosed();
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = () => stop(signal === "SIGINT" ? 130 : 143, signal);
      signalHandlers.set(signal, handler);
      registerSignal(signal, handler);
    }

    for (const [index, child] of children.entries()) {
      child.once("error", (error) => {
        process.stderr.write(
          `[dev] ${processes[index]?.name ?? "child"} failed: ${error.message}\n`,
        );
        closed.add(child);
        stop(1, "SIGTERM", child);
        finishIfClosed();
      });
      child.once("close", (code, signal) => {
        if (closed.has(child)) return;
        closed.add(child);
        if (exitCode === undefined) {
          process.stderr.write(
            `[dev] ${processes[index]?.name ?? "child"} exited unexpectedly: code=${String(code)} signal=${String(signal)}\n`,
          );
          stop(1, "SIGTERM", child);
        }
        finishIfClosed();
      });
    }
  });
}

function developmentProcesses(root: string): DevelopmentProcess[] {
  return [
    {
      args: [
        "--watch",
        "--conditions=development",
        "--import",
        path.join(root, "scripts", "typescript-source-loader.mjs"),
        path.join(root, "apps", "server", "src", "main.ts"),
      ],
      command: process.execPath,
      name: "server",
    },
    {
      args: [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"],
      command: process.execPath,
      name: "web",
    },
  ];
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await superviseDevelopmentProcesses();
}
