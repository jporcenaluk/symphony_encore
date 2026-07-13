import { createHash } from "node:crypto";

import { CONFIGURATION_CATALOG, CONFIGURATION_KEYS, type ConfigurationKey } from "./catalog.js";
import type {
  ConfigurationEntry,
  ConfigurationError,
  ConfigurationResolution,
  ConfigurationSource,
} from "./resolver.js";

export type AcknowledgmentState = "not_required" | "pending" | "acknowledged";
export type ReloadState = "active" | "pending_ack" | "pending_restart";

export interface AppliedConfigurationEntry {
  acknowledgmentState: AcknowledgmentState;
  candidateHash: string;
  candidateSource: ConfigurationSource;
  candidateValue: unknown;
  candidateVersion: string;
  effectiveSource: ConfigurationSource;
  effectiveValue: unknown;
  effectiveVersion: string;
  key: ConfigurationKey;
  readOnly: boolean;
  reload: ConfigurationEntry["reload"];
  reloadState: ReloadState;
  workflowValue: unknown;
}

export interface AppliedConfiguration {
  candidateValues: Partial<Record<ConfigurationKey, unknown>>;
  effectiveValues: Partial<Record<ConfigurationKey, unknown>>;
  entries: Record<ConfigurationKey, AppliedConfigurationEntry>;
  errors: readonly ConfigurationError[];
  status: "active" | "pending" | "candidate_invalid";
}

export interface ApplyConfigurationInput {
  acknowledgedHashes: ReadonlySet<string>;
  candidate: ConfigurationResolution;
  previous?: AppliedConfiguration;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
}

export function candidateHashForEntry(entry: ConfigurationEntry): string {
  const payload = canonicalize({
    key: entry.key,
    source: entry.source,
    value: entry.value,
    version: entry.version,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function requiresAcknowledgment(entry: ConfigurationEntry): boolean {
  const policy = CONFIGURATION_CATALOG[entry.key].acknowledgment;
  if (entry.source === "workflow") return policy === "always" || policy === "file";
  if (entry.source === "operator_override") return policy === "always";
  return false;
}

export function applyConfigurationCandidate(input: ApplyConfigurationInput): AppliedConfiguration {
  if (input.candidate.errors.length > 0 && input.previous) {
    return {
      candidateValues: input.candidate.values,
      effectiveValues: input.previous.effectiveValues,
      entries: input.previous.entries,
      errors: input.candidate.errors,
      status: "candidate_invalid",
    };
  }

  const entries = {} as Record<ConfigurationKey, AppliedConfigurationEntry>;
  const effectiveValues: Partial<Record<ConfigurationKey, unknown>> = {};
  let hasPending = false;

  for (const key of CONFIGURATION_KEYS) {
    const candidate = input.candidate.entries[key];
    const previousEntry = input.previous?.entries[key];
    const candidateHash = candidateHashForEntry(candidate);
    const changed = !previousEntry || !valuesEqual(candidate.value, previousEntry.effectiveValue);
    const acknowledgmentRequired = changed && requiresAcknowledgment(candidate);
    const acknowledged = !acknowledgmentRequired || input.acknowledgedHashes.has(candidateHash);
    let acknowledgmentState: AcknowledgmentState = "not_required";
    if (acknowledgmentRequired) acknowledgmentState = acknowledged ? "acknowledged" : "pending";
    else if (
      changed &&
      candidate.source === "operator_override" &&
      CONFIGURATION_CATALOG[key].acknowledgment === "file"
    ) {
      acknowledgmentState = "acknowledged";
    }

    let effectiveValue = candidate.value;
    let effectiveSource = candidate.source;
    let effectiveVersion = candidate.version;
    let reloadState: ReloadState = "active";
    if (!acknowledged) {
      effectiveValue = previousEntry?.effectiveValue;
      effectiveSource = previousEntry?.effectiveSource ?? "missing";
      effectiveVersion = previousEntry?.effectiveVersion ?? "missing";
      reloadState = "pending_ack";
      hasPending = true;
    } else if (changed && candidate.reload === "restart" && previousEntry) {
      effectiveValue = previousEntry.effectiveValue;
      effectiveSource = previousEntry.effectiveSource;
      effectiveVersion = previousEntry.effectiveVersion;
      reloadState = "pending_restart";
      hasPending = true;
    }

    entries[key] = {
      acknowledgmentState,
      candidateHash,
      candidateSource: candidate.source,
      candidateValue: candidate.value,
      candidateVersion: candidate.version,
      effectiveSource,
      effectiveValue,
      effectiveVersion,
      key,
      readOnly: candidate.readOnly,
      reload: candidate.reload,
      reloadState,
      workflowValue: candidate.workflowValue,
    };
    if (effectiveValue !== undefined) effectiveValues[key] = effectiveValue;
  }

  return {
    candidateValues: input.candidate.values,
    effectiveValues,
    entries,
    errors: input.candidate.errors,
    status: hasPending ? "pending" : "active",
  };
}
