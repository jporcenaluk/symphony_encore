import { describe, expect, it } from "vitest";

import { CONFIGURATION_CATALOG, CONFIGURATION_KEYS } from "./catalog.js";

const expectedKeys = [
  "agent.approval_policy",
  "agent.command",
  "agent.max_concurrent",
  "agent.max_escalations",
  "agent.max_failure_retries",
  "agent.max_plan_revisions",
  "agent.max_retry_backoff_ms",
  "agent.max_rework_cycles",
  "agent.max_turns",
  "agent.read_timeout_ms",
  "agent.required_skills",
  "agent.stall_timeout_ms",
  "agent.thread_sandbox",
  "agent.turn_sandbox_policy",
  "agent.turn_timeout_ms",
  "bootstrap.admin_credential",
  "budget.estimate_tokens_by_profile",
  "budget.history_min_samples",
  "budget.history_window_samples",
  "budget.per_attempt_tokens",
  "budget.per_attempt_usd",
  "budget.per_issue_tokens",
  "budget.per_issue_usd",
  "budget.rolling_24h_tokens",
  "budget.rolling_24h_usd",
  "class.risk_paths",
  "class.trivial_max_changed_lines",
  "class.trivial_patterns",
  "compute.enabled_profiles",
  "compute.risk_floor_rules",
  "compute.route_profiles",
  "env.allowlist",
  "hooks.after_create",
  "hooks.after_run",
  "hooks.before_remove",
  "hooks.before_run",
  "hooks.timeout_ms",
  "human.operators",
  "human.reminder_hours",
  "learning.interval_issues",
  "learning.max_prompt_tokens",
  "learning.max_rules",
  "learning.rule_decay_issues",
  "notify.command",
  "notify.webhook_url",
  "persistence.database_path",
  "persistence.lease_ttl_ms",
  "persistence.retention_days",
  "polling.interval_ms",
  "quality.audit_rate",
  "quality.escape_window_days",
  "review.accepted_check_conclusions",
  "review.max_parallel_specialists",
  "review.quiet_period_ms",
  "review.required_checks",
  "review.settle_timeout_ms",
  "review.snapshot_timeout_ms",
  "review.specialists",
  "server.auth_kind",
  "server.host",
  "server.port",
  "server.session_secret",
  "tracker.acceptance_criteria_heading",
  "tracker.assignee",
  "tracker.kind",
  "tracker.owner",
  "tracker.priority_field",
  "tracker.priority_order",
  "tracker.project_number",
  "tracker.repo_name",
  "tracker.repo_owner",
  "tracker.required_labels",
  "tracker.status_field",
  "ui.live_refresh_ms",
  "workflow.path",
  "workspace.root",
  "workspace.verify_command",
  "workspace.verify_none_reason",
] as const;

describe("configuration catalog", () => {
  it("enumerates every normative Section 18.1 key exactly once", () => {
    expect(CONFIGURATION_KEYS).toEqual(expectedKeys);
    expect(new Set(CONFIGURATION_KEYS).size).toBe(78);
  });

  it("records reload and acknowledgment boundaries", () => {
    expect(CONFIGURATION_CATALOG["workflow.path"]).toMatchObject({
      acknowledgment: "none",
      reload: "bootstrap",
    });
    expect(CONFIGURATION_CATALOG["tracker.kind"]).toMatchObject({
      acknowledgment: "always",
      reload: "restart",
    });
    expect(CONFIGURATION_CATALOG["agent.max_concurrent"]).toMatchObject({
      acknowledgment: "file",
      reload: "hot",
    });
    expect(CONFIGURATION_CATALOG["server.port"]).toMatchObject({
      acknowledgment: "none",
      reload: "restart",
    });
  });

  it("records normative scalar and collection defaults", () => {
    expect(CONFIGURATION_CATALOG["polling.interval_ms"].defaultValue).toBe(30_000);
    expect(CONFIGURATION_CATALOG["tracker.priority_order"].defaultValue).toEqual([
      "P0",
      "Urgent",
      "Critical",
      "P1",
      "High",
      "P2",
      "Medium",
      "P3",
      "Low",
    ]);
    expect(CONFIGURATION_CATALOG["compute.enabled_profiles"].defaultValue).toEqual([
      "economy",
      "standard",
      "deep",
    ]);
    expect(CONFIGURATION_CATALOG["persistence.retention_days"].defaultValue).toBeNull();
  });
});
