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
  type ConfigurationSnapshot,
  inspectBootstrapEligibility,
  loadLatestConfigurationSnapshot,
  openDatabase,
  readControlState,
  readServiceStatus,
  stopServiceRun,
} from "@symphony/persistence";
import type { FastifyBaseLogger } from "fastify";

import { startHttpRuntime } from "./http-runtime.js";
import { createLocalBootstrap } from "./local-bootstrap.js";
import { createLocalSessionAuth } from "./local-session-auth.js";
import { createPersistentControlApi } from "./persistent-control-api.js";
import type { RuntimeOptions } from "./runtime-options.js";
import { recoverLinuxStartupState } from "./startup-recovery.js";

export interface ProductionServiceInput {
  bootstrap?: {
    authSubject: string;
    candidateHash: string;
    configSnapshot: ConfigurationSnapshot;
    credentialHash: string;
    operatorId: string;
  };
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
    if (eligibility.kind === "operator_store_missing_nonpristine") {
      throw new Error("runtime.operator_store_missing_nonpristine");
    }
    const initialSnapshot =
      eligibility.kind === "initialized"
        ? await loadLatestConfigurationSnapshot(opened.database)
        : undefined;
    if (eligibility.kind === "initialized" && initialSnapshot === undefined) {
      throw new Error("runtime.configuration_snapshot_missing");
    }
    if (eligibility.kind === "pristine" && !input.bootstrap) {
      throw new Error("runtime.bootstrap_required");
    }
    if (eligibility.kind === "pristine" && !isLoopbackHost(input.options.host)) {
      throw new Error("runtime.bootstrap_loopback_required");
    }
    const bootstrapInput = eligibility.kind === "pristine" ? input.bootstrap : undefined;

    let serviceRunId: string | undefined;
    async function activate(snapshot: ConfigurationSnapshot) {
      if (serviceRunId !== undefined) throw new Error("runtime.service_already_activated");
      const nextServiceRunId = input.serviceRunId?.() ?? randomUUID();
      await beginServiceRun(opened.database, {
        hostId: input.hostId ?? os.hostname(),
        id: nextServiceRunId,
        serviceVersion: "0.0.0",
        startReason: "startup",
        startedAt: now(),
        startupConfigSnapshotId: snapshot.id,
      });
      await recoverLinuxStartupState({
        completedAt: now(),
        database: opened.database,
        async loadLatestHandoff(attemptId) {
          throw new Error(`recovery.handoff_missing:${attemptId}`);
        },
        quarantineId: nextServiceRunId,
        serviceRunId: nextServiceRunId,
        terminalResultId: (attemptId) => `interrupted:${attemptId}:${nextServiceRunId}`,
        workspaceRoot: input.options.workspaceRoot,
      });
      serviceRunId = nextServiceRunId;
    }

    const auth = createLocalSessionAuth({
      database: opened.database,
      sessionTtlMs: input.options.sessionTtlMs,
    });
    const bootstrap = bootstrapInput
      ? createLocalBootstrap({
          afterCompleted: () => activate(bootstrapInput.configSnapshot),
          authSubject: bootstrapInput.authSubject,
          candidateHash: bootstrapInput.candidateHash,
          configSnapshot: bootstrapInput.configSnapshot,
          database: opened.database,
          expectedCredentialHash: bootstrapInput.credentialHash,
          newActionId: randomUUID,
          now,
          operatorId: bootstrapInput.operatorId,
        })
      : undefined;
    const server = await createPersistentControlApi({
      authenticate: auth.authenticate,
      authenticateMutation: auth.authenticateMutation,
      ...(bootstrap ? { bootstrap } : {}),
      database: opened.database,
      login: auth.login,
      ...(input.logger ? { logger: input.logger } : {}),
      readControlState: () =>
        serviceRunId === undefined
          ? Promise.resolve(bootstrapControlState(input.bootstrap?.candidateHash ?? "unavailable"))
          : readControlState(opened.database),
      readServiceStatus: () =>
        serviceRunId === undefined
          ? Promise.resolve({
              id: `bootstrap:${input.bootstrap?.candidateHash ?? "unavailable"}`,
              state: "starting" as const,
            })
          : readServiceStatus(opened.database),
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
    if (bootstrapInput) {
      (input.output ?? ((line) => process.stdout.write(`${line}\n`)))(
        `Bootstrap candidate: ${bootstrapInput.candidateHash}`,
      );
    } else if (initialSnapshot) {
      await activate(initialSnapshot);
    }

    let closed = false;
    return {
      async close() {
        if (closed) return;
        closed = true;
        if (serviceRunId !== undefined) {
          await stopServiceRun(opened.database, {
            endedAt: now(),
            endReason: "signal",
            serviceRunId,
          });
        }
        await httpRuntime?.close();
        await opened.close();
      },
      server,
      get serviceRunId() {
        return serviceRunId;
      },
      url: httpRuntime.url,
    };
  } catch (error) {
    await httpRuntime?.close();
    await opened.close();
    throw error;
  }
}

function bootstrapControlState(candidateHash: string) {
  return {
    dispatch_enabled: false,
    mutations_enabled: false,
    service_run: {
      id: `bootstrap:${candidateHash}`,
      service_version: "0.0.0",
      started_at: "bootstrap",
      status: "starting" as const,
    },
    version: `bootstrap:${candidateHash}`,
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
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
