import { createHash } from "node:crypto";
import path from "node:path";
import {
  type AcknowledgmentState,
  type AppliedConfiguration,
  applyConfigurationCandidate,
  CONFIGURATION_CATALOG,
  CONFIGURATION_KEYS,
  type ConfigurationOverride,
  type ConfigurationSource,
  candidateHashForEntry,
  type LoadedWorkflow,
  type ReloadState,
  resolveConfiguration,
} from "@symphony/orchestration";
import type { ConfigurationSnapshot } from "@symphony/persistence";

import type { RuntimeOptions } from "./runtime-options.js";

export interface CreateStartupConfigurationInput {
  acknowledgedHashes: ReadonlySet<string>;
  createdAt: string;
  environment: Readonly<Record<string, string | undefined>>;
  home: string;
  id: string;
  options: RuntimeOptions;
  overrides: readonly ConfigurationOverride[];
  previousSnapshot: ConfigurationSnapshot;
  restartBoundaryReached?: boolean;
  systemTemp: string;
  workflow: LoadedWorkflow;
}

export interface StartupConfiguration {
  configuration: AppliedConfiguration;
  prompt: string;
  snapshot: ConfigurationSnapshot;
  warnings: readonly string[];
}

export function createStartupConfiguration(
  input: CreateStartupConfigurationInput,
): StartupConfiguration {
  const candidate = resolveConfiguration({
    bootstrap: {
      "persistence.database_path": input.options.databasePath,
      "workflow.path": input.options.workflowPath,
    },
    context: {
      authSuppliesSessions: true,
      environment: input.environment,
      home: input.home,
      processCwd: path.dirname(input.options.workflowPath),
      serviceDataRoot: path.dirname(input.options.databasePath),
      systemTemp: input.systemTemp,
      workflowDirectory: path.dirname(input.workflow.path),
      workflowVersion: input.workflow.sourceHash,
    },
    overrides: input.overrides,
    workflow: input.workflow.config,
  });
  const configuration = applyConfigurationCandidate({
    acknowledgedHashes: input.acknowledgedHashes,
    candidate,
    previous: configurationFromSnapshot(input.previousSnapshot),
    restartBoundaryReached: input.restartBoundaryReached ?? true,
  });
  if (configuration.status === "candidate_invalid") {
    const first = configuration.errors[0];
    throw new Error(
      first
        ? `startup.configuration_invalid:${first.code}:${first.key}`
        : "startup.configuration_invalid",
    );
  }

  const snapshot: ConfigurationSnapshot = {
    acknowledgmentState: Object.fromEntries(
      CONFIGURATION_KEYS.map((key) => [key, configuration.entries[key].acknowledgmentState]),
    ),
    adapterVersions: input.previousSnapshot.adapterVersions,
    createdAt: input.createdAt,
    effectiveConfig: configuration.effectiveValues,
    id: input.id,
    operatorOverrideRevision: Math.max(0, ...input.overrides.map(({ version }) => version)),
    promptHash: sha256(input.workflow.prompt),
    restartState: Object.fromEntries(
      CONFIGURATION_KEYS.map((key) => [key, configuration.entries[key].reloadState]),
    ),
    sourceMetadata: Object.fromEntries(
      CONFIGURATION_KEYS.map((key) => [
        key,
        {
          source: configuration.entries[key].effectiveSource,
          version: configuration.entries[key].effectiveVersion,
        },
      ]),
    ),
    workflowSourceHash: input.workflow.sourceHash,
  };
  return {
    configuration,
    prompt: input.workflow.prompt,
    snapshot,
    warnings: input.workflow.warnings,
  };
}

function configurationFromSnapshot(snapshot: ConfigurationSnapshot): AppliedConfiguration {
  const entries = Object.fromEntries(
    CONFIGURATION_KEYS.map((key) => {
      const value = snapshot.effectiveConfig[key];
      const metadata = record(snapshot.sourceMetadata[key]);
      const source = configurationSource(metadata.source, value);
      const version = typeof metadata.version === "string" ? metadata.version : "snapshot:unknown";
      const base = {
        key,
        readOnly: CONFIGURATION_CATALOG[key].reload === "bootstrap",
        reload: CONFIGURATION_CATALOG[key].reload,
        source,
        value,
        version,
        workflowValue: undefined,
      };
      return [
        key,
        {
          acknowledgmentState: acknowledgmentState(snapshot.acknowledgmentState[key]),
          candidateHash: candidateHashForEntry(base),
          candidateSource: source,
          candidateValue: value,
          candidateVersion: version,
          effectiveSource: source,
          effectiveValue: value,
          effectiveVersion: version,
          key,
          readOnly: base.readOnly,
          reload: base.reload,
          reloadState: reloadState(snapshot.restartState[key]),
          workflowValue: undefined,
        },
      ];
    }),
  ) as AppliedConfiguration["entries"];
  return {
    candidateValues: snapshot.effectiveConfig,
    effectiveValues: snapshot.effectiveConfig,
    entries,
    errors: [],
    status: "active",
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configurationSource(value: unknown, effectiveValue: unknown): ConfigurationSource {
  return value === "default" ||
    value === "workflow" ||
    value === "operator_override" ||
    value === "bootstrap" ||
    value === "missing"
    ? value
    : effectiveValue === undefined
      ? "missing"
      : "default";
}

function acknowledgmentState(value: unknown): AcknowledgmentState {
  return value === "pending" || value === "acknowledged" || value === "not_required"
    ? value
    : "not_required";
}

function reloadState(value: unknown): ReloadState {
  return value === "pending_ack" || value === "pending_restart" || value === "active"
    ? value
    : "active";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
