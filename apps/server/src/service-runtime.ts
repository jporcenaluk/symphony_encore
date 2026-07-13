import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_KEYS,
  type ConfigurationKey,
} from "@symphony/orchestration";
import {
  applyMigrations,
  beginServiceRun,
  inspectBootstrapEligibility,
  loadLatestConfigurationSnapshot,
  openDatabase,
  stopServiceRun,
} from "@symphony/persistence";
import type { FastifyBaseLogger } from "fastify";

import { startHttpRuntime } from "./http-runtime.js";
import { createLocalSessionAuth } from "./local-session-auth.js";
import { createPersistentControlApi } from "./persistent-control-api.js";
import type { RuntimeOptions } from "./runtime-options.js";
import { recoverLinuxStartupState } from "./startup-recovery.js";

export interface ProductionServiceInput {
  hostId?: string;
  listen?: (options: { host: string; port: number }) => Promise<string>;
  logger?: FastifyBaseLogger;
  now?: () => string;
  options: RuntimeOptions;
  output?: (line: string) => void;
  serviceRunId?: () => string;
}

export async function startProductionService(input: ProductionServiceInput) {
  const now = input.now ?? (() => new Date().toISOString());
  await mkdir(path.dirname(input.options.databasePath), { recursive: true });
  await mkdir(input.options.workspaceRoot, { recursive: true });
  const opened = openDatabase(input.options.databasePath);
  let httpRuntime: Awaited<ReturnType<typeof startHttpRuntime>> | undefined;
  try {
    await applyMigrations(opened.database);
    const eligibility = await inspectBootstrapEligibility(opened.database);
    if (eligibility.kind === "pristine") throw new Error("runtime.bootstrap_required");
    if (eligibility.kind === "operator_store_missing_nonpristine") {
      throw new Error("runtime.operator_store_missing_nonpristine");
    }
    const snapshot = await loadLatestConfigurationSnapshot(opened.database);
    if (snapshot === undefined) throw new Error("runtime.configuration_snapshot_missing");

    const serviceRunId = input.serviceRunId?.() ?? randomUUID();
    await beginServiceRun(opened.database, {
      hostId: input.hostId ?? os.hostname(),
      id: serviceRunId,
      serviceVersion: "0.0.0",
      startReason: "startup",
      startedAt: now(),
      startupConfigSnapshotId: snapshot.id,
    });
    const auth = createLocalSessionAuth({
      database: opened.database,
      sessionTtlMs: input.options.sessionTtlMs,
    });
    const server = await createPersistentControlApi({
      authenticate: auth.authenticate,
      authenticateMutation: auth.authenticateMutation,
      database: opened.database,
      login: auth.login,
      ...(input.logger ? { logger: input.logger } : {}),
      sessionCookieSecure: input.options.secureCookies,
      validateConfigurationOverride,
    });
    httpRuntime = await startHttpRuntime({
      host: input.options.host,
      ...(input.listen ? { listen: input.listen } : {}),
      ...(input.output ? { output: input.output } : {}),
      port: input.options.port,
      server,
      uiRoot: input.options.uiRoot,
    });
    await recoverLinuxStartupState({
      completedAt: now(),
      database: opened.database,
      async loadLatestHandoff(attemptId) {
        throw new Error(`recovery.handoff_missing:${attemptId}`);
      },
      quarantineId: serviceRunId,
      serviceRunId,
      terminalResultId: (attemptId) => `interrupted:${attemptId}:${serviceRunId}`,
      workspaceRoot: input.options.workspaceRoot,
    });

    let closed = false;
    return {
      async close() {
        if (closed) return;
        closed = true;
        await stopServiceRun(opened.database, {
          endedAt: now(),
          endReason: "signal",
          serviceRunId,
        });
        await httpRuntime?.close();
        await opened.close();
      },
      server,
      serviceRunId,
      url: httpRuntime.url,
    };
  } catch (error) {
    await httpRuntime?.close();
    await opened.close();
    throw error;
  }
}

function validateConfigurationOverride(input: {
  key: string;
  operation: "set" | "clear";
  value?: unknown;
}): string | null {
  if (!CONFIGURATION_KEYS.includes(input.key as ConfigurationKey)) return "config.unknown_key";
  const definition = CONFIGURATION_CATALOG[input.key as ConfigurationKey];
  if (definition.reload === "bootstrap") return "config.bootstrap_read_only";
  if (input.operation === "set" && input.value === undefined) return "config.value_required";
  return null;
}
