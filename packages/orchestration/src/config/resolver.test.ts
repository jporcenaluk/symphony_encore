import { describe, expect, it } from "vitest";

import { resolveConfiguration } from "./resolver.js";

const validWorkflow = {
  agent: {
    approval_policy: "on-request",
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: "workspace-write",
  },
  human: {
    operators: [
      {
        auth_subject: "local:admin",
        capabilities: ["operator.read", "config.write", "config.ack"],
        id: "admin",
        tracker_login: "octocat",
      },
    ],
  },
  server: { auth_kind: "local", session_secret: "$SESSION_SECRET" },
  tracker: {
    kind: "github",
    owner: "example",
    project_number: 1,
    repo_name: "repo",
    repo_owner: "example",
  },
  workspace: { root: "./workspaces", verify_command: "make verify" },
};

const context = {
  environment: { SESSION_SECRET: "resolved-but-never-returned" },
  home: "/home/operator",
  processCwd: "/service",
  serviceDataRoot: "/var/lib/symphony",
  systemTemp: "/tmp",
  workflowDirectory: "/repo",
  workflowVersion: "workflow:abc123",
};

describe("configuration resolution", () => {
  it("resolves defaults, workflow, overrides, and bootstrap values with provenance", () => {
    const result = resolveConfiguration({
      bootstrap: {
        "persistence.database_path": "/data/control.sqlite3",
        "workflow.path": "/repo/WORKFLOW.md",
      },
      context,
      overrides: [{ key: "polling.interval_ms", value: 5_000, version: 3 }],
      workflow: {
        ...validWorkflow,
        polling: { interval_ms: 10_000 },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.values["polling.interval_ms"]).toBe(5_000);
    expect(result.entries["polling.interval_ms"]).toMatchObject({
      source: "operator_override",
      version: "override:3",
      workflowValue: 10_000,
    });
    expect(result.values["tracker.status_field"]).toBe("Status");
    expect(result.entries["tracker.status_field"].source).toBe("default");
    expect(result.values["workspace.root"]).toBe("/repo/workspaces");
    expect(result.values["persistence.database_path"]).toBe("/data/control.sqlite3");
    expect(result.entries["persistence.database_path"]).toMatchObject({
      readOnly: true,
      source: "bootstrap",
    });
    expect(result.values["server.session_secret"]).toBe("$SESSION_SECRET");
    expect(JSON.stringify(result)).not.toContain("resolved-but-never-returned");
  });

  it("rejects durable overrides for bootstrap-only keys", () => {
    const result = resolveConfiguration({
      context,
      overrides: [{ key: "workflow.path", value: "/other/WORKFLOW.md", version: 1 }],
      workflow: validWorkflow,
    });

    expect(result.errors).toContainEqual({
      code: "config.bootstrap_override_forbidden",
      key: "workflow.path",
    });
  });

  it("requires GitHub identity keys and ordinary required values", () => {
    const result = resolveConfiguration({
      context,
      workflow: {
        ...validWorkflow,
        agent: {},
        tracker: { kind: "github" },
      },
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        { code: "config.required", key: "tracker.owner" },
        { code: "config.required", key: "tracker.project_number" },
        { code: "config.required", key: "agent.approval_policy" },
      ]),
    );
  });

  it("rejects literal or unresolved secret values", () => {
    const literal = resolveConfiguration({
      context,
      workflow: { ...validWorkflow, server: { auth_kind: "local", session_secret: "literal" } },
    });
    expect(literal.errors).toContainEqual({
      code: "config.secret_reference_required",
      key: "server.session_secret",
    });

    const missing = resolveConfiguration({
      context: { ...context, environment: {} },
      workflow: validWorkflow,
    });
    expect(missing.errors).toContainEqual({
      code: "config.secret_missing",
      key: "server.session_secret",
    });
  });

  it("enforces verify-none, nonblank lists, history windows, and operator invariants", () => {
    const result = resolveConfiguration({
      context,
      workflow: {
        ...validWorkflow,
        budget: { history_min_samples: 51, history_window_samples: 50 },
        human: {
          operators: [
            {
              auth_subject: "same",
              capabilities: ["operator.read"],
              id: "duplicate",
              tracker_login: "same",
            },
            {
              auth_subject: "same",
              capabilities: ["operator.read"],
              id: "duplicate",
              tracker_login: "same",
            },
          ],
        },
        tracker: { ...validWorkflow.tracker, required_labels: ["ready", ""] },
        workspace: { verify_command: "none" },
      },
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        { code: "config.verify_none_reason_required", key: "workspace.verify_none_reason" },
        { code: "config.blank_list_value", key: "tracker.required_labels" },
        { code: "config.history_window_invalid", key: "budget.history_min_samples" },
        { code: "config.operator_duplicate_id", key: "human.operators" },
        { code: "config.operator_duplicate_subject", key: "human.operators" },
        { code: "config.operator_duplicate_login", key: "human.operators" },
        { code: "config.operator_capability_missing", key: "human.operators" },
      ]),
    );
  });

  it("validates adapter capabilities, required skills, and tracker schema before dispatch", () => {
    const result = resolveConfiguration({
      context: {
        ...context,
        adapterCapabilities: {
          acceptedCheckConclusions: ["success", "neutral"],
          approvalPolicies: ["never"],
          profiles: ["economy", "standard"],
          threadSandboxes: ["read-only"],
          turnSandboxPolicies: ["read-only"],
        },
        resolvedSkills: [],
        trackerSchema: {
          lanes: ["Backlog", "Todo", "In Progress", "Review", "Human"],
          writeAuthority: false,
        },
      },
      workflow: {
        ...validWorkflow,
        agent: {
          approval_policy: "on-request",
          required_skills: ["commit"],
          thread_sandbox: "workspace-write",
          turn_sandbox_policy: "workspace-write",
        },
        budget: {
          estimate_tokens_by_profile: { deep: 0, economy: 100, standard: 200 },
        },
        compute: { enabled_profiles: ["economy", "standard", "deep"] },
        review: { accepted_check_conclusions: ["success", "skipped"] },
      },
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        { code: "config.profile_unavailable", key: "compute.enabled_profiles" },
        { code: "config.required_skill_missing", key: "agent.required_skills" },
        { code: "config.approval_policy_unsupported", key: "agent.approval_policy" },
        { code: "config.thread_sandbox_unsupported", key: "agent.thread_sandbox" },
        { code: "config.turn_sandbox_unsupported", key: "agent.turn_sandbox_policy" },
        {
          code: "config.check_conclusion_unsupported",
          key: "review.accepted_check_conclusions",
        },
        { code: "config.profile_estimate_invalid", key: "budget.estimate_tokens_by_profile" },
        { code: "config.tracker_lanes_missing", key: "tracker.status_field" },
        { code: "config.tracker_write_unavailable", key: "tracker.status_field" },
      ]),
    );
  });
});
