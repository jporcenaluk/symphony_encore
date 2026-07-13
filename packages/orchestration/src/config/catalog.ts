export type ReloadBoundary = "hot" | "attempt" | "restart" | "bootstrap";
export type AcknowledgmentPolicy = "none" | "always" | "file";
export type ConfigurationValueType =
  | "string"
  | "nullable_string"
  | "integer"
  | "number"
  | "ratio"
  | "string_list"
  | "map"
  | "list"
  | "path"
  | "script"
  | "secret_reference"
  | "integer_or_null"
  | "adapter_value";

export interface ConfigurationContext {
  processCwd: string;
  serviceDataRoot: string;
  systemTemp: string;
}

export interface ConfigurationDefinition {
  acknowledgment: AcknowledgmentPolicy;
  defaultFactory?: (context: ConfigurationContext) => unknown;
  defaultValue?: unknown;
  reload: ReloadBoundary;
  required?: boolean;
  requiredForGithub?: boolean;
  type: ConfigurationValueType;
}

const builtInRiskRules = [
  "risk.security_auth",
  "risk.migration_data",
  "risk.concurrency",
  "risk.public_api",
  "risk.cross_package_architecture",
  "risk.ambiguous_criteria",
].map((id) => ({ id, minimum_profile: "deep", roles: ["implementation"] }));

const defaultSpecialists = [
  {
    concerns: ["security", "data_integrity", "concurrency", "failure_modes"],
    excluded_context: ["builder_narrative", "self_review"],
    name: "systems_security",
    profile: "deep",
    required_evidence: ["diff", "checks", "acceptance_criteria"],
    trigger_rules: ["risk.security_auth", "risk.migration_data", "risk.concurrency"],
  },
  {
    concerns: ["api_coherence", "maintainability", "product_behavior"],
    excluded_context: ["builder_narrative", "self_review"],
    name: "architecture_product",
    profile: "deep",
    required_evidence: ["diff", "checks", "acceptance_criteria"],
    trigger_rules: ["risk.public_api", "risk.cross_package_architecture"],
  },
];

export const CONFIGURATION_CATALOG = {
  "agent.approval_policy": {
    acknowledgment: "always",
    reload: "attempt",
    required: true,
    type: "adapter_value",
  },
  "agent.command": {
    acknowledgment: "always",
    defaultValue: "codex app-server",
    reload: "attempt",
    type: "string",
  },
  "agent.max_concurrent": {
    acknowledgment: "file",
    defaultValue: 4,
    reload: "hot",
    type: "integer",
  },
  "agent.max_escalations": {
    acknowledgment: "file",
    defaultValue: 1,
    reload: "attempt",
    type: "integer",
  },
  "agent.max_failure_retries": {
    acknowledgment: "file",
    defaultValue: 2,
    reload: "attempt",
    type: "integer",
  },
  "agent.max_plan_revisions": {
    acknowledgment: "file",
    defaultValue: 2,
    reload: "attempt",
    type: "integer",
  },
  "agent.max_retry_backoff_ms": {
    acknowledgment: "none",
    defaultValue: 300_000,
    reload: "hot",
    type: "integer",
  },
  "agent.max_rework_cycles": {
    acknowledgment: "file",
    defaultValue: 2,
    reload: "attempt",
    type: "integer",
  },
  "agent.max_turns": {
    acknowledgment: "file",
    defaultValue: 8,
    reload: "attempt",
    type: "integer",
  },
  "agent.read_timeout_ms": {
    acknowledgment: "none",
    defaultValue: 5_000,
    reload: "attempt",
    type: "integer",
  },
  "agent.required_skills": {
    acknowledgment: "file",
    defaultValue: [],
    reload: "attempt",
    type: "string_list",
  },
  "agent.stall_timeout_ms": {
    acknowledgment: "file",
    defaultValue: 300_000,
    reload: "hot",
    type: "integer",
  },
  "agent.thread_sandbox": {
    acknowledgment: "always",
    reload: "attempt",
    required: true,
    type: "adapter_value",
  },
  "agent.turn_sandbox_policy": {
    acknowledgment: "always",
    reload: "attempt",
    required: true,
    type: "adapter_value",
  },
  "agent.turn_timeout_ms": {
    acknowledgment: "file",
    defaultValue: 900_000,
    reload: "attempt",
    type: "integer",
  },
  "bootstrap.admin_credential": {
    acknowledgment: "none",
    reload: "bootstrap",
    type: "secret_reference",
  },
  "budget.estimate_tokens_by_profile": {
    acknowledgment: "file",
    defaultValue: { deep: 300_000, economy: 100_000, standard: 200_000 },
    reload: "hot",
    type: "map",
  },
  "budget.history_min_samples": {
    acknowledgment: "file",
    defaultValue: 10,
    reload: "hot",
    type: "integer",
  },
  "budget.history_window_samples": {
    acknowledgment: "file",
    defaultValue: 50,
    reload: "hot",
    type: "integer",
  },
  "budget.per_attempt_tokens": {
    acknowledgment: "file",
    defaultValue: 400_000,
    reload: "attempt",
    type: "integer",
  },
  "budget.per_attempt_usd": {
    acknowledgment: "file",
    defaultValue: 5,
    reload: "attempt",
    type: "number",
  },
  "budget.per_issue_tokens": {
    acknowledgment: "file",
    defaultValue: 2_000_000,
    reload: "hot",
    type: "integer",
  },
  "budget.per_issue_usd": {
    acknowledgment: "file",
    defaultValue: 10,
    reload: "hot",
    type: "number",
  },
  "budget.rolling_24h_tokens": {
    acknowledgment: "file",
    defaultValue: 10_000_000,
    reload: "hot",
    type: "integer",
  },
  "budget.rolling_24h_usd": {
    acknowledgment: "file",
    defaultValue: 50,
    reload: "hot",
    type: "number",
  },
  "class.risk_paths": {
    acknowledgment: "file",
    defaultValue: [],
    reload: "attempt",
    type: "string_list",
  },
  "class.trivial_max_changed_lines": {
    acknowledgment: "file",
    defaultValue: 25,
    reload: "attempt",
    type: "integer",
  },
  "class.trivial_patterns": {
    acknowledgment: "file",
    defaultValue: [],
    reload: "attempt",
    type: "string_list",
  },
  "compute.enabled_profiles": {
    acknowledgment: "file",
    defaultValue: ["economy", "standard", "deep"],
    reload: "attempt",
    type: "string_list",
  },
  "compute.risk_floor_rules": {
    acknowledgment: "file",
    defaultValue: builtInRiskRules,
    reload: "attempt",
    type: "list",
  },
  "compute.route_profiles": {
    acknowledgment: "file",
    defaultValue: {
      adjudication: "deep",
      implementation: { high_risk: "deep", standard: "standard", trivial: "economy" },
      integrative_review: "standard",
      plan_review: "economy",
      specialist_review: "deep",
      synthesis: "deep",
    },
    reload: "attempt",
    type: "map",
  },
  "env.allowlist": {
    acknowledgment: "always",
    defaultValue: [],
    reload: "attempt",
    type: "string_list",
  },
  "hooks.after_create": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "attempt",
    type: "script",
  },
  "hooks.after_run": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "attempt",
    type: "script",
  },
  "hooks.before_remove": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "attempt",
    type: "script",
  },
  "hooks.before_run": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "attempt",
    type: "script",
  },
  "hooks.timeout_ms": {
    acknowledgment: "none",
    defaultValue: 60_000,
    reload: "attempt",
    type: "integer",
  },
  "human.operators": {
    acknowledgment: "always",
    reload: "hot",
    required: true,
    type: "list",
  },
  "human.reminder_hours": {
    acknowledgment: "none",
    defaultValue: 24,
    reload: "hot",
    type: "integer",
  },
  "learning.interval_issues": {
    acknowledgment: "none",
    defaultValue: 25,
    reload: "hot",
    type: "integer",
  },
  "learning.max_prompt_tokens": {
    acknowledgment: "none",
    defaultValue: 4_000,
    reload: "attempt",
    type: "integer",
  },
  "learning.max_rules": {
    acknowledgment: "none",
    defaultValue: 25,
    reload: "attempt",
    type: "integer",
  },
  "learning.rule_decay_issues": {
    acknowledgment: "none",
    defaultValue: 100,
    reload: "hot",
    type: "integer",
  },
  "notify.command": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "hot",
    type: "nullable_string",
  },
  "notify.webhook_url": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "hot",
    type: "nullable_string",
  },
  "persistence.database_path": {
    acknowledgment: "none",
    defaultFactory: ({ serviceDataRoot }) => `${serviceDataRoot}/symphony-encore.sqlite3`,
    reload: "bootstrap",
    type: "path",
  },
  "persistence.lease_ttl_ms": {
    acknowledgment: "none",
    defaultValue: 120_000,
    reload: "hot",
    type: "integer",
  },
  "persistence.retention_days": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "hot",
    type: "integer_or_null",
  },
  "polling.interval_ms": {
    acknowledgment: "none",
    defaultValue: 30_000,
    reload: "hot",
    type: "integer",
  },
  "quality.audit_rate": {
    acknowledgment: "file",
    defaultValue: 0.1,
    reload: "hot",
    type: "ratio",
  },
  "quality.escape_window_days": {
    acknowledgment: "file",
    defaultValue: 14,
    reload: "hot",
    type: "integer",
  },
  "review.accepted_check_conclusions": {
    acknowledgment: "file",
    defaultValue: ["success", "neutral", "skipped"],
    reload: "hot",
    type: "string_list",
  },
  "review.max_parallel_specialists": {
    acknowledgment: "file",
    defaultValue: 2,
    reload: "attempt",
    type: "integer",
  },
  "review.quiet_period_ms": {
    acknowledgment: "none",
    defaultValue: 0,
    reload: "hot",
    type: "integer",
  },
  "review.required_checks": {
    acknowledgment: "file",
    defaultValue: [],
    reload: "hot",
    type: "string_list",
  },
  "review.settle_timeout_ms": {
    acknowledgment: "none",
    defaultValue: 1_800_000,
    reload: "hot",
    type: "integer",
  },
  "review.snapshot_timeout_ms": {
    acknowledgment: "none",
    defaultValue: 30_000,
    reload: "hot",
    type: "integer",
  },
  "review.specialists": {
    acknowledgment: "file",
    defaultValue: defaultSpecialists,
    reload: "attempt",
    type: "list",
  },
  "server.auth_kind": {
    acknowledgment: "always",
    reload: "restart",
    required: true,
    type: "string",
  },
  "server.host": {
    acknowledgment: "always",
    defaultValue: "127.0.0.1",
    reload: "restart",
    type: "string",
  },
  "server.port": {
    acknowledgment: "none",
    defaultValue: 8080,
    reload: "restart",
    type: "integer",
  },
  "server.session_secret": {
    acknowledgment: "always",
    reload: "restart",
    type: "secret_reference",
  },
  "tracker.acceptance_criteria_heading": {
    acknowledgment: "always",
    defaultValue: "Acceptance Criteria",
    reload: "hot",
    type: "string",
  },
  "tracker.assignee": {
    acknowledgment: "always",
    defaultValue: null,
    reload: "hot",
    type: "nullable_string",
  },
  "tracker.kind": {
    acknowledgment: "always",
    reload: "restart",
    required: true,
    type: "string",
  },
  "tracker.owner": {
    acknowledgment: "always",
    reload: "restart",
    requiredForGithub: true,
    type: "string",
  },
  "tracker.priority_field": {
    acknowledgment: "none",
    defaultValue: "Priority",
    reload: "hot",
    type: "string",
  },
  "tracker.priority_order": {
    acknowledgment: "none",
    defaultValue: ["P0", "Urgent", "Critical", "P1", "High", "P2", "Medium", "P3", "Low"],
    reload: "hot",
    type: "string_list",
  },
  "tracker.project_number": {
    acknowledgment: "always",
    reload: "restart",
    requiredForGithub: true,
    type: "integer",
  },
  "tracker.repo_name": {
    acknowledgment: "always",
    reload: "restart",
    requiredForGithub: true,
    type: "string",
  },
  "tracker.repo_owner": {
    acknowledgment: "always",
    reload: "restart",
    requiredForGithub: true,
    type: "string",
  },
  "tracker.required_labels": {
    acknowledgment: "always",
    defaultValue: [],
    reload: "hot",
    type: "string_list",
  },
  "tracker.status_field": {
    acknowledgment: "always",
    defaultValue: "Status",
    reload: "hot",
    type: "string",
  },
  "ui.live_refresh_ms": {
    acknowledgment: "none",
    defaultValue: 1_000,
    reload: "hot",
    type: "integer",
  },
  "workflow.path": {
    acknowledgment: "none",
    defaultFactory: ({ processCwd }) => `${processCwd}/WORKFLOW.md`,
    reload: "bootstrap",
    type: "path",
  },
  "workspace.root": {
    acknowledgment: "always",
    defaultFactory: ({ systemTemp }) => `${systemTemp}/symphony_workspaces`,
    reload: "restart",
    type: "path",
  },
  "workspace.verify_command": {
    acknowledgment: "always",
    reload: "attempt",
    required: true,
    type: "string",
  },
  "workspace.verify_none_reason": {
    acknowledgment: "none",
    defaultValue: null,
    reload: "attempt",
    type: "nullable_string",
  },
} as const satisfies Record<string, ConfigurationDefinition>;

export type ConfigurationKey = keyof typeof CONFIGURATION_CATALOG;

export const CONFIGURATION_KEYS = Object.freeze(
  Object.keys(CONFIGURATION_CATALOG).sort() as ConfigurationKey[],
);
