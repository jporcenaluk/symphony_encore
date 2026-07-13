import { createHash } from "node:crypto";
import path from "node:path";
import {
  CONFIGURATION_KEYS,
  type LoadedWorkflow,
  resolveConfiguration,
} from "@symphony/orchestration";
import { type ConfigurationSnapshot, REQUIRED_OPERATOR_CAPABILITIES } from "@symphony/persistence";
import type { RuntimeOptions } from "./runtime-options.js";
import type { ProductionServiceInput } from "./service-runtime.js";

export interface BuildBootstrapCandidateInput {
  createdAt: string;
  environment: Readonly<Record<string, string | undefined>>;
  home: string;
  options: RuntimeOptions;
  systemTemp: string;
  workflow: LoadedWorkflow;
}

export function buildBootstrapCandidate(
  input: BuildBootstrapCandidateInput,
): ProductionServiceInput["bootstrap"] {
  const { createdAt, options, workflow } = input;
  if (!options.bootstrapAuthSubject || !options.bootstrapCredentialHash) return undefined;
  const operator = {
    auth_subject: options.bootstrapAuthSubject,
    capabilities: [...REQUIRED_OPERATOR_CAPABILITIES],
    id: "bootstrap-admin",
  };
  const context = {
    authSuppliesSessions: true,
    environment: {
      ...input.environment,
      SYMPHONY_BOOTSTRAP_CREDENTIAL: "present-at-trusted-boundary",
    },
    home: input.home,
    pristineStore: true,
    processCwd: path.dirname(options.workflowPath),
    serviceDataRoot: path.dirname(options.databasePath),
    systemTemp: input.systemTemp,
    workflowDirectory: path.dirname(workflow.path),
    workflowVersion: workflow.sourceHash,
  };
  const bootstrapValues = {
    "bootstrap.admin_credential": "$SYMPHONY_BOOTSTRAP_CREDENTIAL",
    "persistence.database_path": options.databasePath,
    "workflow.path": options.workflowPath,
  };
  const preBootstrap = resolveConfiguration({
    bootstrap: bootstrapValues,
    context,
    workflow: withoutOperators(workflow.config),
  });
  assertValid(preBootstrap.errors);

  const ordinary = resolveConfiguration({
    bootstrap: {
      "persistence.database_path": options.databasePath,
      "workflow.path": options.workflowPath,
    },
    context: { ...context, pristineStore: false },
    workflow: withOperator(workflow.config, operator),
  });
  assertValid(ordinary.errors);

  const effectiveConfig = Object.fromEntries(
    CONFIGURATION_KEYS.flatMap((key) =>
      ordinary.values[key] === undefined ? [] : [[key, ordinary.values[key]]],
    ),
  );
  const sourceMetadata = Object.fromEntries(
    CONFIGURATION_KEYS.map((key) => [
      key,
      { source: ordinary.entries[key].source, version: ordinary.entries[key].version },
    ]),
  );
  const candidateHash = sha256({
    authSubject: options.bootstrapAuthSubject,
    effectiveConfig,
    operatorCapabilities: REQUIRED_OPERATOR_CAPABILITIES,
    promptHash: sha256(workflow.prompt),
    workflowSourceHash: workflow.sourceHash,
  });
  const configSnapshot: ConfigurationSnapshot = {
    acknowledgmentState: Object.fromEntries(CONFIGURATION_KEYS.map((key) => [key, "acknowledged"])),
    adapterVersions: { auth: "local:1" },
    createdAt,
    effectiveConfig,
    id: `bootstrap-${candidateHash.slice("sha256:".length)}`,
    operatorOverrideRevision: 0,
    promptHash: sha256(workflow.prompt),
    restartState: Object.fromEntries(CONFIGURATION_KEYS.map((key) => [key, "active"])),
    sourceMetadata,
    workflowSourceHash: workflow.sourceHash,
  };
  return {
    authSubject: options.bootstrapAuthSubject,
    candidateHash,
    configSnapshot,
    credentialHash: options.bootstrapCredentialHash,
    operatorId: operator.id,
  };
}

function assertValid(errors: readonly { code: string; key: string }[]): void {
  const first = errors[0];
  if (first) throw new Error(`bootstrap.configuration_invalid:${first.code}:${first.key}`);
}

function withoutOperators(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = structuredClone(config) as Record<string, unknown>;
  const human = copy.human;
  if (typeof human === "object" && human !== null && !Array.isArray(human)) {
    delete (human as Record<string, unknown>).operators;
    if (Object.keys(human).length === 0) delete copy.human;
  }
  return copy;
}

function withOperator(
  config: Readonly<Record<string, unknown>>,
  operator: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const copy = withoutOperators(config);
  const human =
    typeof copy.human === "object" && copy.human !== null && !Array.isArray(copy.human)
      ? (copy.human as Record<string, unknown>)
      : {};
  copy.human = { ...human, operators: [operator] };
  return copy;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
}
