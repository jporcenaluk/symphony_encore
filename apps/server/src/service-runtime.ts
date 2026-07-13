import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SideEffectIntent, SideEffectReceipt } from "@symphony/contracts";
import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_KEYS,
  type ConfigurationKey,
  parseWorkflowText,
} from "@symphony/orchestration";
import {
  appendEventRecord,
  applyMigrations,
  beginServiceRun,
  type ConfigurationSnapshot,
  inspectBootstrapEligibility,
  loadAcknowledgedCandidateHashes,
  loadActiveOverrides,
  loadLatestConfigurationSnapshot,
  loadLatestHandoffForAttempt,
  type OpenedDatabase,
  openDatabase,
  readControlState,
  readServiceStatus,
  stopServiceRun,
  storeConfigurationSnapshot,
} from "@symphony/persistence";
import type { FastifyBaseLogger } from "fastify";

import { recoverCorruptOperatorStore } from "./corrupt-store-recovery.js";
import { startHttpRuntime } from "./http-runtime.js";
import { createLocalBootstrap } from "./local-bootstrap.js";
import { createLocalSessionAuth } from "./local-session-auth.js";
import { createPersistentControlApi } from "./persistent-control-api.js";
import type { RuntimeOptions } from "./runtime-options.js";
import { createStartupConfiguration } from "./startup-configuration.js";
import { recoverLinuxStartupState } from "./startup-recovery.js";
import {
  createWorkflowFileMonitor,
  type WorkflowFileMonitor,
  type WorkflowFileMonitorInput,
} from "./workflow-file-monitor.js";

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
  lookupReceiptByIdempotencyKey?: (intent: SideEffectIntent) => Promise<SideEffectReceipt | null>;
  now?: () => string;
  options: RuntimeOptions;
  output?: (line: string) => void;
  schedulerFactory?: (input: {
    database: OpenedDatabase["database"];
    serviceRunId: string;
    snapshot: ConfigurationSnapshot;
  }) => { close(): Promise<void>; start(): Promise<void> };
  serviceRunId?: () => string;
  startupConfiguration?: {
    environment: Readonly<Record<string, string | undefined>>;
    home: string;
    systemTemp: string;
    workflow: Parameters<typeof createStartupConfiguration>[0]["workflow"];
  };
  workflowMonitorFactory?: (input: WorkflowFileMonitorInput) => WorkflowFileMonitor;
}

export async function startProductionService(input: ProductionServiceInput) {
  const now = input.now ?? (() => new Date().toISOString());
  await mkdir(path.dirname(input.options.databasePath), { recursive: true });
  const opened = openDatabase(input.options.databasePath);
  let httpRuntime: Awaited<ReturnType<typeof startHttpRuntime>> | undefined;
  let scheduler: { close(): Promise<void>; start(): Promise<void> } | undefined;
  let workflowMonitor: WorkflowFileMonitor | undefined;
  try {
    await applyMigrations(opened.database);
    const eligibility = await inspectBootstrapEligibility(opened.database);
    if (eligibility.kind === "operator_store_missing_nonpristine") {
      const recovery = await recoverCorruptOperatorStore({
        database: opened.database,
        failureId: randomUUID(),
        ...(input.lookupReceiptByIdempotencyKey
          ? { lookupReceiptByIdempotencyKey: input.lookupReceiptByIdempotencyKey }
          : {}),
        occurredAt: now(),
        populatedTables: eligibility.populatedTables,
      });
      input.logger?.error(
        { reason_code: "operator_store_missing_nonpristine", recovery },
        "operator store corruption",
      );
      throw new Error("runtime.operator_store_missing_nonpristine");
    }
    let initialSnapshot =
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
    if (initialSnapshot && input.startupConfiguration) {
      const startup = createStartupConfiguration({
        acknowledgedHashes: await loadAcknowledgedCandidateHashes(opened.database),
        createdAt: now(),
        environment: input.startupConfiguration.environment,
        home: input.startupConfiguration.home,
        id: randomUUID(),
        options: input.options,
        overrides: (await loadActiveOverrides(opened.database)).flatMap((override) =>
          CONFIGURATION_KEYS.includes(override.key as ConfigurationKey)
            ? [override as { key: ConfigurationKey; value: unknown; version: number }]
            : [],
        ),
        previousSnapshot: initialSnapshot,
        systemTemp: input.startupConfiguration.systemTemp,
        workflow: input.startupConfiguration.workflow,
      });
      await storeConfigurationSnapshot(opened.database, startup.snapshot);
      initialSnapshot = startup.snapshot;
      for (const warning of startup.warnings) input.logger?.warn({ warning }, "workflow warning");
    }
    const runtimeOptions = optionsFromSnapshot(
      input.options,
      bootstrapInput?.configSnapshot ?? initialSnapshot,
    );
    if (bootstrapInput && !isLoopbackHost(runtimeOptions.host)) {
      throw new Error("runtime.bootstrap_loopback_required");
    }
    if (!isLoopbackHost(runtimeOptions.host) && !runtimeOptions.allowNonLoopback) {
      throw new Error("runtime.non_loopback_ack_required");
    }
    if (!isLoopbackHost(runtimeOptions.host) && !runtimeOptions.secureCookies) {
      throw new Error("runtime.secure_cookies_required");
    }
    await mkdir(runtimeOptions.workspaceRoot, { recursive: true });

    let serviceRunId: string | undefined;
    async function startWorkflowMonitor(snapshot: ConfigurationSnapshot) {
      if (!input.startupConfiguration || workflowMonitor) return;
      const startupInput = input.startupConfiguration;
      const workflowPath = startupInput.workflow.path;
      const factory = input.workflowMonitorFactory ?? createWorkflowFileMonitor;
      workflowMonitor = factory({
        initialSourceHash: snapshot.workflowSourceHash,
        intervalMs: 1_000,
        async onCandidate(candidate) {
          if (serviceRunId === undefined) return;
          try {
            const parsed = parseWorkflowText(candidate.source);
            const reloaded = createStartupConfiguration({
              acknowledgedHashes: await loadAcknowledgedCandidateHashes(opened.database),
              createdAt: now(),
              environment: startupInput.environment,
              home: startupInput.home,
              id: randomUUID(),
              options: input.options,
              overrides: (await loadActiveOverrides(opened.database)).flatMap((override) =>
                CONFIGURATION_KEYS.includes(override.key as ConfigurationKey)
                  ? [override as { key: ConfigurationKey; value: unknown; version: number }]
                  : [],
              ),
              previousSnapshot:
                (await loadLatestConfigurationSnapshot(opened.database)) ?? snapshot,
              restartBoundaryReached: false,
              systemTemp: startupInput.systemTemp,
              workflow: {
                ...parsed,
                path: workflowPath,
                sourceHash: candidate.sourceHash,
              },
            });
            await storeConfigurationSnapshot(opened.database, reloaded.snapshot);
            await appendEventRecord(opened.database, {
              attemptId: null,
              changeClass: null,
              computeProfile: null,
              costUsd: null,
              eventName: "workflow.reload",
              id: randomUUID(),
              payload: { source_hash: candidate.sourceHash },
              reasonCode: `workflow.${reloaded.configuration.status}`,
              result: "accepted",
              serviceRunId,
              timestamp: now(),
              workRef: null,
            });
            for (const warning of reloaded.warnings) {
              input.logger?.warn({ warning }, "workflow warning");
            }
          } catch (error) {
            const reasonCode =
              error instanceof Error ? error.message : "workflow.reload_unknown_error";
            await appendEventRecord(opened.database, {
              attemptId: null,
              changeClass: null,
              computeProfile: null,
              costUsd: null,
              eventName: "workflow.reload",
              id: randomUUID(),
              payload: { source_hash: candidate.sourceHash },
              reasonCode,
              result: "rejected",
              serviceRunId,
              timestamp: now(),
              workRef: null,
            });
            input.logger?.warn({ reason_code: reasonCode }, "workflow reload rejected");
          }
        },
        onReadError(error) {
          input.logger?.warn({ error }, "workflow file monitor failed");
        },
        readSource: () => readFile(workflowPath, "utf8"),
      });
    }

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
        loadLatestHandoff: (attemptId) => loadLatestHandoffForAttempt(opened.database, attemptId),
        quarantineId: nextServiceRunId,
        serviceRunId: nextServiceRunId,
        terminalResultId: (attemptId) => `interrupted:${attemptId}:${nextServiceRunId}`,
        workspaceRoot: runtimeOptions.workspaceRoot,
      });
      serviceRunId = nextServiceRunId;
      await startWorkflowMonitor(snapshot);
      scheduler = input.schedulerFactory?.({
        database: opened.database,
        serviceRunId: nextServiceRunId,
        snapshot,
      });
      await scheduler?.start();
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
      sessionCookieSecure: runtimeOptions.secureCookies,
      validateConfigurationOverride,
    });
    httpRuntime = await startHttpRuntime({
      host: runtimeOptions.host,
      ...(input.listen ? { listen: input.listen } : {}),
      ...(input.output ? { output: input.output } : {}),
      port: runtimeOptions.port,
      server,
      uiRoot: runtimeOptions.uiRoot,
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
        let closeError: unknown;
        try {
          await scheduler?.close();
        } catch (error) {
          closeError = error;
        }
        try {
          await workflowMonitor?.close();
        } catch (error) {
          closeError ??= error;
        }
        try {
          if (serviceRunId !== undefined) {
            await stopServiceRun(opened.database, {
              endedAt: now(),
              endReason: "signal",
              serviceRunId,
            });
          }
        } catch (error) {
          closeError ??= error;
        }
        try {
          await httpRuntime?.close();
        } catch (error) {
          closeError ??= error;
        }
        try {
          await opened.close();
        } catch (error) {
          closeError ??= error;
        }
        if (closeError) throw closeError;
      },
      server,
      get serviceRunId() {
        return serviceRunId;
      },
      url: httpRuntime.url,
    };
  } catch (error) {
    await scheduler?.close().catch(() => undefined);
    await workflowMonitor?.close().catch(() => undefined);
    await httpRuntime?.close().catch(() => undefined);
    await opened.close().catch(() => undefined);
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

function optionsFromSnapshot(
  options: RuntimeOptions,
  snapshot: ConfigurationSnapshot | undefined,
): RuntimeOptions {
  if (!snapshot) return options;
  const host = snapshot.effectiveConfig["server.host"];
  const port = snapshot.effectiveConfig["server.port"];
  const workspaceRoot = snapshot.effectiveConfig["workspace.root"];
  return {
    ...options,
    host: typeof host === "string" ? host : options.host,
    port: typeof port === "number" ? port : options.port,
    workspaceRoot: typeof workspaceRoot === "string" ? workspaceRoot : options.workspaceRoot,
  };
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
