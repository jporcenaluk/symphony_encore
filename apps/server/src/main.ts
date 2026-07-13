import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRootLogger } from "@symphony/observability";
import { loadWorkflowFile } from "@symphony/orchestration";

import { buildBootstrapCandidate } from "./bootstrap-candidate.js";
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
    const options = parseRuntimeOptions(process.env, process.cwd());
    const workflow = await loadWorkflowFile({
      cwd: process.cwd(),
      readFile: (filename) => readFile(filename, "utf8"),
      trustedPath: options.workflowPath,
    });
    const bootstrap =
      options.bootstrapAuthSubject && options.bootstrapCredentialHash
        ? buildBootstrapCandidate({
            createdAt: new Date().toISOString(),
            environment: process.env,
            home: homedir(),
            options,
            systemTemp: tmpdir(),
            workflow,
          })
        : undefined;
    const service = await startProductionService({
      ...(bootstrap ? { bootstrap } : {}),
      logger,
      options,
      startupConfiguration: {
        environment: process.env,
        home: homedir(),
        systemTemp: tmpdir(),
        workflow,
      },
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
