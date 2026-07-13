import { pathToFileURL } from "node:url";
import { createRootLogger } from "@symphony/observability";

import { parseRuntimeOptions } from "./runtime-options.js";
import { startProductionService } from "./service-runtime.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";
type SignalRegistrar = (signal: ShutdownSignal, handler: () => void) => void;

export function installShutdownHandlers(
  close: () => Promise<void>,
  register: SignalRegistrar = (signal, handler) => process.once(signal, handler),
  onError: (error: unknown) => void = () => undefined,
) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void close().catch(onError);
  };
  register("SIGINT", stop);
  register("SIGTERM", stop);
}

export async function runProductionMain() {
  const logger = createRootLogger({ level: process.env.LOG_LEVEL ?? "info" });
  try {
    const service = await startProductionService({
      logger,
      options: parseRuntimeOptions(process.env, process.cwd()),
    });
    installShutdownHandlers(service.close, undefined, (error) => {
      logger.fatal({ error }, "service shutdown failed");
      process.exitCode = 1;
    });
    return service;
  } catch (error) {
    logger.fatal({ error }, "service startup failed");
    process.exitCode = 1;
    return undefined;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProductionMain();
}
