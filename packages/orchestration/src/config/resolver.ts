import path from "node:path";

import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_KEYS,
  type ConfigurationContext,
  type ConfigurationDefinition,
  type ConfigurationKey,
} from "./catalog.js";
import { parseComputeRoutingPolicy } from "./compute-policy.js";

export type ConfigurationSource =
  | "default"
  | "workflow"
  | "operator_override"
  | "bootstrap"
  | "missing";

export interface ConfigurationEntry {
  key: ConfigurationKey;
  readOnly: boolean;
  reload: ConfigurationDefinition["reload"];
  source: ConfigurationSource;
  value: unknown;
  version: string;
  workflowValue: unknown;
}

export interface ConfigurationError {
  code: string;
  key: string;
}

export interface ConfigurationOverride {
  key: ConfigurationKey;
  value: unknown;
  version: number;
}

export interface ResolutionContext extends ConfigurationContext {
  adapterCapabilities?: {
    acceptedCheckConclusions: readonly string[];
    approvalPolicies: readonly unknown[];
    profiles: readonly string[];
    threadSandboxes: readonly unknown[];
    turnSandboxPolicies: readonly unknown[];
  };
  authSuppliesSessions?: boolean;
  environment: Readonly<Record<string, string | undefined>>;
  home: string;
  pristineStore?: boolean;
  workflowDirectory: string;
  workflowVersion: string;
  resolvedSkills?: readonly string[];
  trackerSchema?: {
    lanes: readonly string[];
    writeAuthority: boolean;
  };
}

export interface ResolveConfigurationInput {
  bootstrap?: Readonly<Record<string, unknown>>;
  context: ResolutionContext;
  overrides?: readonly ConfigurationOverride[];
  workflow: Readonly<Record<string, unknown>>;
}

export interface ConfigurationResolution {
  entries: Record<ConfigurationKey, ConfigurationEntry>;
  errors: readonly ConfigurationError[];
  values: Partial<Record<ConfigurationKey, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenWorkflow(workflow: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const flattened = new Map<string, unknown>();
  for (const [namespace, nested] of Object.entries(workflow)) {
    if (!isRecord(nested)) continue;
    for (const [key, value] of Object.entries(nested)) flattened.set(`${namespace}.${key}`, value);
  }
  return flattened;
}

function cloneDefault(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizePath(key: ConfigurationKey, value: unknown, context: ResolutionContext): unknown {
  if (typeof value !== "string") return value;
  const expanded =
    value === "~"
      ? context.home
      : value.startsWith("~/")
        ? path.join(context.home, value.slice(2))
        : value;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  const base =
    key === "workspace.root"
      ? context.workflowDirectory
      : key === "persistence.database_path"
        ? context.serviceDataRoot
        : context.processCwd;
  return path.resolve(base, expanded);
}

function valueMatchesType(
  definition: ConfigurationDefinition,
  value: unknown,
  environment: ResolutionContext["environment"],
): "valid" | "invalid" | "secret_reference_required" | "secret_missing" {
  switch (definition.type) {
    case "string":
    case "path":
      return typeof value === "string" && value.trim().length > 0 ? "valid" : "invalid";
    case "nullable_string":
      return value === null || (typeof value === "string" && value.trim().length > 0)
        ? "valid"
        : "invalid";
    case "script":
      return value === null || (typeof value === "string" && value.trim().length > 0)
        ? "valid"
        : "invalid";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? "valid" : "invalid";
    case "integer_or_null":
      return value === null || (typeof value === "number" && Number.isInteger(value))
        ? "valid"
        : "invalid";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? "valid" : "invalid";
    case "ratio":
      return typeof value === "number" && value >= 0 && value <= 1 ? "valid" : "invalid";
    case "string_list":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? "valid"
        : "invalid";
    case "list":
      return Array.isArray(value) ? "valid" : "invalid";
    case "map":
      return isRecord(value) ? "valid" : "invalid";
    case "adapter_value":
      return value !== null && value !== undefined && value !== "" ? "valid" : "invalid";
    case "secret_reference": {
      if (typeof value !== "string" || !/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
        return "secret_reference_required";
      }
      const resolved = environment[value.slice(1)];
      return resolved === undefined || resolved.length === 0 ? "secret_missing" : "valid";
    }
  }
}

const POSITIVE_INTEGER_KEYS = new Set<ConfigurationKey>([
  "agent.max_concurrent",
  "agent.max_escalations",
  "agent.max_failure_retries",
  "agent.max_plan_revisions",
  "agent.max_retry_backoff_ms",
  "agent.max_rework_cycles",
  "agent.max_turns",
  "agent.read_timeout_ms",
  "agent.turn_timeout_ms",
  "budget.history_min_samples",
  "budget.history_window_samples",
  "budget.per_attempt_tokens",
  "budget.per_issue_tokens",
  "budget.rolling_24h_tokens",
  "class.trivial_max_changed_lines",
  "hooks.timeout_ms",
  "human.reminder_hours",
  "learning.interval_issues",
  "learning.max_prompt_tokens",
  "learning.max_rules",
  "learning.rule_decay_issues",
  "persistence.lease_ttl_ms",
  "polling.interval_ms",
  "quality.escape_window_days",
  "review.max_parallel_specialists",
  "review.settle_timeout_ms",
  "review.snapshot_timeout_ms",
  "server.port",
  "tracker.project_number",
  "ui.live_refresh_ms",
]);

const POSITIVE_NUMBER_KEYS = new Set<ConfigurationKey>([
  "budget.per_attempt_usd",
  "budget.per_issue_usd",
  "budget.rolling_24h_usd",
]);

function addError(errors: ConfigurationError[], code: string, key: string): void {
  if (!errors.some((error) => error.code === code && error.key === key)) errors.push({ code, key });
}

function validateOperators(
  value: unknown,
  errors: ConfigurationError[],
  allowMissing: boolean,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    if (allowMissing && value === undefined) return;
    addError(errors, "config.required", "human.operators");
    return;
  }
  const ids = new Set<string>();
  const subjects = new Set<string>();
  const logins = new Set<string>();
  let hasConfigAdministrator = false;
  for (const operator of value) {
    if (!isRecord(operator)) {
      addError(errors, "config.invalid_operator", "human.operators");
      continue;
    }
    const id = operator.id;
    const subject = operator.auth_subject;
    const login = operator.tracker_login;
    const capabilities = operator.capabilities;
    if (typeof id !== "string" || id.trim().length === 0 || !Array.isArray(capabilities)) {
      addError(errors, "config.invalid_operator", "human.operators");
      continue;
    }
    if (ids.has(id)) addError(errors, "config.operator_duplicate_id", "human.operators");
    ids.add(id);
    if (typeof subject !== "string" || subject.trim().length === 0) {
      addError(errors, "config.invalid_operator", "human.operators");
    } else {
      if (subjects.has(subject)) {
        addError(errors, "config.operator_duplicate_subject", "human.operators");
      }
      subjects.add(subject);
    }
    if (login !== undefined) {
      if (typeof login !== "string" || login.trim().length === 0) {
        addError(errors, "config.invalid_operator", "human.operators");
      } else {
        if (logins.has(login)) {
          addError(errors, "config.operator_duplicate_login", "human.operators");
        }
        logins.add(login);
      }
    }
    if (capabilities.includes("config.write") && capabilities.includes("config.ack")) {
      hasConfigAdministrator = true;
    }
  }
  if (!hasConfigAdministrator) {
    addError(errors, "config.operator_capability_missing", "human.operators");
  }
}

export function resolveConfiguration(input: ResolveConfigurationInput): ConfigurationResolution {
  const errors: ConfigurationError[] = [];
  const values: Partial<Record<ConfigurationKey, unknown>> = {};
  const entries = {} as Record<ConfigurationKey, ConfigurationEntry>;
  const workflowValues = flattenWorkflow(input.workflow);
  const overrides = new Map((input.overrides ?? []).map((override) => [override.key, override]));
  const bootstrap = input.bootstrap ?? {};

  for (const key of CONFIGURATION_KEYS) {
    const definition: ConfigurationDefinition = CONFIGURATION_CATALOG[key];
    const isBootstrap = definition.reload === "bootstrap";
    const workflowValue = workflowValues.get(key);
    const override = overrides.get(key);
    let value: unknown;
    let source: ConfigurationSource = "missing";
    let version = "missing";

    if (Object.hasOwn(definition, "defaultValue")) {
      value = cloneDefault(definition.defaultValue);
      source = "default";
      version = "default:1";
    } else if (definition.defaultFactory) {
      value = definition.defaultFactory(input.context);
      source = "default";
      version = "default:1";
    }
    if (workflowValue !== undefined) {
      if (isBootstrap) addError(errors, "config.bootstrap_workflow_forbidden", key);
      else {
        value = workflowValue;
        source = "workflow";
        version = input.context.workflowVersion;
      }
    }
    if (override) {
      if (isBootstrap) addError(errors, "config.bootstrap_override_forbidden", key);
      else {
        value = override.value;
        source = "operator_override";
        version = `override:${override.version}`;
      }
    }
    if (Object.hasOwn(bootstrap, key)) {
      if (!isBootstrap) addError(errors, "config.nonbootstrap_trusted_value", key);
      else {
        value = bootstrap[key];
        source = "bootstrap";
        version = "bootstrap:1";
      }
    }
    if (definition.type === "path" && value !== undefined) {
      value = normalizePath(key, value, input.context);
    }

    entries[key] = {
      key,
      readOnly: isBootstrap,
      reload: definition.reload,
      source,
      value,
      version,
      workflowValue,
    };
    if (value !== undefined) values[key] = value;

    const required =
      (definition.required && !(key === "human.operators" && input.context.pristineStore)) ||
      (definition.requiredForGithub && values["tracker.kind"] === "github") ||
      (key === "server.session_secret" && !input.context.authSuppliesSessions) ||
      (key === "bootstrap.admin_credential" && input.context.pristineStore === true);
    if (required && value === undefined) addError(errors, "config.required", key);
    if (value !== undefined) {
      const validity = valueMatchesType(definition, value, input.context.environment);
      if (validity === "invalid") addError(errors, "config.invalid_type", key);
      else if (validity === "secret_reference_required") {
        addError(errors, "config.secret_reference_required", key);
      } else if (validity === "secret_missing") addError(errors, "config.secret_missing", key);

      if (
        definition.type === "string_list" &&
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && item.trim().length === 0)
      ) {
        addError(errors, "config.blank_list_value", key);
      }
      if (POSITIVE_INTEGER_KEYS.has(key) && (typeof value !== "number" || value <= 0)) {
        addError(errors, "config.must_be_positive", key);
      }
      if (POSITIVE_NUMBER_KEYS.has(key) && (typeof value !== "number" || value <= 0)) {
        addError(errors, "config.must_be_positive", key);
      }
    }
  }

  if (
    values["workspace.verify_command"] === "none" &&
    (typeof values["workspace.verify_none_reason"] !== "string" ||
      values["workspace.verify_none_reason"].trim().length === 0)
  ) {
    addError(errors, "config.verify_none_reason_required", "workspace.verify_none_reason");
  }
  const historyMin = values["budget.history_min_samples"];
  const historyWindow = values["budget.history_window_samples"];
  if (
    typeof historyMin === "number" &&
    typeof historyWindow === "number" &&
    historyMin > historyWindow
  ) {
    addError(errors, "config.history_window_invalid", "budget.history_min_samples");
  }
  const retention = values["persistence.retention_days"];
  if (typeof retention === "number" && retention <= 0) {
    addError(errors, "config.must_be_positive", "persistence.retention_days");
  }
  const port = values["server.port"];
  if (typeof port === "number" && (port < 1 || port > 65_535)) {
    addError(errors, "config.port_invalid", "server.port");
  }
  validateOperators(values["human.operators"], errors, input.context.pristineStore === true);

  const capabilities = input.context.adapterCapabilities;
  if (capabilities) {
    const profiles = values["compute.enabled_profiles"];
    if (
      Array.isArray(profiles) &&
      profiles.some(
        (profile) => typeof profile !== "string" || !capabilities.profiles.includes(profile),
      )
    ) {
      addError(errors, "config.profile_unavailable", "compute.enabled_profiles");
    }
    const approvalPolicy = values["agent.approval_policy"];
    if (!capabilities.approvalPolicies.some((supported) => Object.is(supported, approvalPolicy))) {
      addError(errors, "config.approval_policy_unsupported", "agent.approval_policy");
    }
    const threadSandbox = values["agent.thread_sandbox"];
    if (!capabilities.threadSandboxes.some((supported) => Object.is(supported, threadSandbox))) {
      addError(errors, "config.thread_sandbox_unsupported", "agent.thread_sandbox");
    }
    const turnSandbox = values["agent.turn_sandbox_policy"];
    if (!capabilities.turnSandboxPolicies.some((supported) => Object.is(supported, turnSandbox))) {
      addError(errors, "config.turn_sandbox_unsupported", "agent.turn_sandbox_policy");
    }
    const conclusions = values["review.accepted_check_conclusions"];
    if (
      Array.isArray(conclusions) &&
      conclusions.some(
        (conclusion) =>
          typeof conclusion !== "string" ||
          !capabilities.acceptedCheckConclusions.includes(conclusion),
      )
    ) {
      addError(errors, "config.check_conclusion_unsupported", "review.accepted_check_conclusions");
    }
  }

  const requiredSkills = values["agent.required_skills"];
  if (
    input.context.resolvedSkills &&
    Array.isArray(requiredSkills) &&
    requiredSkills.some(
      (skill) => typeof skill !== "string" || !input.context.resolvedSkills?.includes(skill),
    )
  ) {
    addError(errors, "config.required_skill_missing", "agent.required_skills");
  }

  const estimates = values["budget.estimate_tokens_by_profile"];
  const enabledProfiles = values["compute.enabled_profiles"];
  if (
    isRecord(estimates) &&
    Array.isArray(enabledProfiles) &&
    enabledProfiles.some((profile) => {
      const estimate = typeof profile === "string" ? estimates[profile] : undefined;
      return typeof estimate !== "number" || !Number.isInteger(estimate) || estimate <= 0;
    })
  ) {
    addError(errors, "config.profile_estimate_invalid", "budget.estimate_tokens_by_profile");
  }

  try {
    parseComputeRoutingPolicy({
      riskFloorRules: values["compute.risk_floor_rules"],
      routeProfiles: values["compute.route_profiles"],
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "config.compute_policy_invalid";
    addError(
      errors,
      code,
      code === "config.compute_route_profiles_invalid"
        ? "compute.route_profiles"
        : "compute.risk_floor_rules",
    );
  }

  if (input.context.trackerSchema) {
    const requiredLanes = ["Backlog", "Todo", "In Progress", "Review", "Human", "Done"];
    if (requiredLanes.some((lane) => !input.context.trackerSchema?.lanes.includes(lane))) {
      addError(errors, "config.tracker_lanes_missing", "tracker.status_field");
    }
    if (!input.context.trackerSchema.writeAuthority) {
      addError(errors, "config.tracker_write_unavailable", "tracker.status_field");
    }
  }

  return { entries, errors, values };
}
