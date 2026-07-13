import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface ParsedWorkflow {
  config: Record<string, unknown>;
  prompt: string;
  warnings: readonly string[];
}

export interface LoadedWorkflow extends ParsedWorkflow {
  path: string;
  sourceHash: string;
}

export interface WorkflowFileInput {
  cwd: string;
  readFile(file: string): Promise<string>;
  trustedPath?: string;
}

const CORE_KEYS: Readonly<Record<string, readonly string[] | "extension">> = {
  agent: [
    "command",
    "read_timeout_ms",
    "max_concurrent",
    "max_turns",
    "turn_timeout_ms",
    "stall_timeout_ms",
    "max_failure_retries",
    "max_rework_cycles",
    "max_plan_revisions",
    "max_escalations",
    "max_retry_backoff_ms",
    "required_skills",
    "approval_policy",
    "thread_sandbox",
    "turn_sandbox_policy",
  ],
  bootstrap: ["admin_credential"],
  budget: [
    "per_attempt_tokens",
    "per_attempt_usd",
    "per_issue_usd",
    "rolling_24h_usd",
    "per_issue_tokens",
    "rolling_24h_tokens",
    "estimate_tokens_by_profile",
    "history_min_samples",
    "history_window_samples",
  ],
  class: ["trivial_max_changed_lines", "trivial_patterns", "risk_paths"],
  compute: ["enabled_profiles", "route_profiles", "risk_floor_rules"],
  env: ["allowlist"],
  extensions: "extension",
  hooks: ["after_create", "before_run", "after_run", "before_remove", "timeout_ms"],
  human: ["operators", "reminder_hours"],
  learning: ["interval_issues", "max_rules", "max_prompt_tokens", "rule_decay_issues"],
  notify: ["command", "webhook_url"],
  persistence: ["database_path", "lease_ttl_ms", "retention_days"],
  polling: ["interval_ms"],
  quality: ["audit_rate", "escape_window_days"],
  review: [
    "max_parallel_specialists",
    "specialists",
    "required_checks",
    "accepted_check_conclusions",
    "snapshot_timeout_ms",
    "settle_timeout_ms",
    "quiet_period_ms",
  ],
  server: ["port", "host", "auth_kind", "session_secret"],
  tracker: [
    "kind",
    "owner",
    "project_number",
    "repo_owner",
    "repo_name",
    "status_field",
    "priority_field",
    "priority_order",
    "acceptance_criteria_heading",
    "assignee",
    "required_labels",
  ],
  ui: ["live_refresh_ms"],
  workflow: ["path"],
  workspace: ["root", "verify_command", "verify_none_reason"],
};

const SAFETY_NAMESPACES = [
  "budget",
  "hooks",
  "agent",
  "workspace",
  "env",
  "human",
  "tracker",
  "server",
  "bootstrap",
  "persistence",
  "notify",
  "review",
  "compute",
  "class",
  "quality",
] as const;

const BOOTSTRAP_KEYS = new Set([
  "workflow.path",
  "persistence.database_path",
  "bootstrap.admin_credential",
]);

const TEMPLATE_ROOTS = new Set([
  "work_ref",
  "issue",
  "system_job",
  "attempt",
  "change_class",
  "plan",
  "rules",
]);

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}

function closest(value: string, candidates: readonly string[]): string | undefined {
  return candidates
    .map((candidate) => ({ candidate, distance: levenshtein(value.toLowerCase(), candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    )[0]?.candidate;
}

function filterConfiguration(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  warnings: string[];
} {
  const filtered: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [namespace, value] of Object.entries(config)) {
    const knownKeys = CORE_KEYS[namespace];
    if (!knownKeys) {
      const near = closest(namespace, SAFETY_NAMESPACES);
      if (near && levenshtein(namespace.toLowerCase(), near) <= 2) {
        throw new Error(`workflow.safety_key_near_miss:${namespace}:${near}`);
      }
      warnings.push(`workflow.unknown_key:${namespace}`);
      continue;
    }
    if (knownKeys === "extension") {
      filtered[namespace] = value;
      continue;
    }
    if (!isMap(value)) throw new Error(`workflow.namespace_not_map:${namespace}`);

    const filteredNamespace: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const fullKey = `${namespace}.${key}`;
      if (BOOTSTRAP_KEYS.has(fullKey)) {
        throw new Error(`workflow.bootstrap_key_forbidden:${fullKey}`);
      }
      if (!knownKeys.includes(key)) {
        const near = closest(key, knownKeys);
        if (
          SAFETY_NAMESPACES.includes(namespace as (typeof SAFETY_NAMESPACES)[number]) &&
          near &&
          levenshtein(key.toLowerCase(), near) <= 2
        ) {
          throw new Error(`workflow.safety_key_near_miss:${fullKey}:${namespace}.${near}`);
        }
        warnings.push(`workflow.unknown_key:${fullKey}`);
        continue;
      }
      filteredNamespace[key] = nestedValue;
    }
    if (Object.keys(filteredNamespace).length > 0) filtered[namespace] = filteredNamespace;
  }
  return { config: filtered, warnings };
}

function validateTemplate(prompt: string): void {
  for (const match of prompt.matchAll(/\{\{([\s\S]*?)\}\}/gu)) {
    const expression = (match[1] ?? "").trim();
    if (expression.includes("|")) throw new Error("workflow.template_filter_forbidden");
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(expression)) {
      throw new Error(`workflow.template_unknown_variable:${expression}`);
    }
    const root = expression.split(".")[0] ?? "";
    if (!TEMPLATE_ROOTS.has(root)) {
      throw new Error(`workflow.template_unknown_variable:${expression}`);
    }
  }
}

export function parseWorkflowText(source: string): ParsedWorkflow {
  const lines = source.split(/\r?\n/u);
  let unfilteredConfig: Record<string, unknown> = {};
  let promptSource = source;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end === -1) throw new Error("workflow.front_matter_unterminated");
    const yamlSource = lines.slice(1, end).join("\n");
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlSource);
    } catch {
      throw new Error("workflow.front_matter_invalid");
    }
    if (!isMap(parsed)) throw new Error("workflow.front_matter_not_map");
    unfilteredConfig = parsed;
    promptSource = lines.slice(end + 1).join("\n");
  }

  const prompt = promptSource.trim();
  if (prompt.length === 0) throw new Error("workflow.prompt_empty");
  validateTemplate(prompt);
  const filtered = filterConfiguration(unfilteredConfig);
  return { config: filtered.config, prompt, warnings: filtered.warnings };
}

export async function loadWorkflowFile(input: WorkflowFileInput): Promise<LoadedWorkflow> {
  const selectedPath = path.resolve(input.cwd, input.trustedPath ?? "WORKFLOW.md");
  let source: string;
  try {
    source = await input.readFile(selectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`workflow.file_missing:${selectedPath}`);
    }
    throw error;
  }
  return {
    ...parseWorkflowText(source),
    path: selectedPath,
    sourceHash: `sha256:${createHash("sha256").update(source).digest("hex")}`,
  };
}
