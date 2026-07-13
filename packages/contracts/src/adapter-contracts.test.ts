import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  AGENT_ERROR_FAILURE_CLASS,
  AgentAdapterManifestSchema,
  AgentEventSchema,
  PullRequestSnapshotSchema,
  TrackerIssuePageSchema,
  validateAgentToolArguments,
  validateCompletePage,
  validatePullRequestSnapshot,
} from "./adapter-contracts.js";

describe("normalized agent adapter contracts", () => {
  it("validates serialized JSON schemas used by provider tool calls", () => {
    const schema = {
      additionalProperties: false,
      properties: { outcome: { const: "success" }, tokens: { minimum: 0, type: "integer" } },
      required: ["outcome", "tokens"],
      type: "object",
    };

    expect(validateAgentToolArguments(schema, { outcome: "success", tokens: 3 })).toBe(true);
    expect(validateAgentToolArguments(schema, { outcome: "wrong", tokens: 3 })).toBe(false);
    expect(validateAgentToolArguments(schema, { extra: true, outcome: "success", tokens: 3 })).toBe(
      false,
    );
  });

  it("accepts absolute token usage and rejects provider-specific extras", () => {
    const event = {
      attempt_id: "attempt-1",
      billable_categories: { cached_input: 10 },
      cost_usd: 0.01,
      event: "token_usage",
      input_tokens: 100,
      output_tokens: 20,
      session_id: "thread-1-turn-1",
      timestamp: "2026-07-13T10:00:00Z",
      total_tokens: 120,
    };
    expect(Value.Check(AgentEventSchema, event)).toBe(true);
    expect(Value.Check(AgentEventSchema, { ...event, last_token_usage: 20 })).toBe(false);
  });

  it("publishes immutable protocol, profile, price, and capability metadata", () => {
    expect(
      Value.Check(AgentAdapterManifestSchema, {
        adapter_version: "codex-1",
        capabilities: ["terminal_result", "submit_plan", "skills"],
        price_table: {
          models: {
            "gpt-example": { input_per_million_usd: 1, output_per_million_usd: 4 },
          },
          version: "2026-07-13",
        },
        profiles: {
          deep: { model: "gpt-example", reasoning_effort: "high" },
          economy: { model: "gpt-example", reasoning_effort: "low" },
          standard: { model: "gpt-example", reasoning_effort: "medium" },
        },
        protocol: { maximum: "2.0", minimum: "1.0", schema_hash: "sha256:protocol" },
      }),
    ).toBe(true);
  });

  it("maps every normalized error without inspecting provider prose", () => {
    expect(AGENT_ERROR_FAILURE_CLASS.agent_not_found).toBe("configuration");
    expect(AGENT_ERROR_FAILURE_CLASS.auth_failed).toBe("auth");
    expect(AGENT_ERROR_FAILURE_CLASS.overloaded).toBe("infrastructure");
    expect(AGENT_ERROR_FAILURE_CLASS.token_cap_exceeded).toBe("budget_exhausted");
    expect(Object.keys(AGENT_ERROR_FAILURE_CLASS)).toHaveLength(16);
  });
});

describe("tracker and repository-hosting contracts", () => {
  it("fails closed when a provider reports more pages without a cursor", () => {
    const page = { cursor: null, has_more: true, items: [] };
    expect(Value.Check(TrackerIssuePageSchema, page)).toBe(true);
    expect(validateCompletePage(page)).toEqual({
      ok: false,
      reason: "pagination.missing_cursor",
    });
    expect(validateCompletePage({ ...page, cursor: "cursor-2" })).toEqual({ ok: true });
  });

  it("requires normalized checks, reviews, and unresolved threads in PR snapshots", () => {
    const snapshot = {
      base_ref: "main",
      checks: [],
      head_sha: "bbbbbbb",
      is_draft: false,
      mergeable: true,
      observed_base_sha: "aaaaaaa",
      post_merge_checks: [],
      pr_number: 1,
      pr_state: "open",
      pr_url: "https://github.com/jporc/wheelsparrow/pull/1",
      required_check_source: "union",
      review_decision: "none",
      reviews: [],
      unresolved_threads: [],
    };
    expect(Value.Check(PullRequestSnapshotSchema, snapshot)).toBe(true);
    expect(validatePullRequestSnapshot(snapshot)).toEqual({ ok: true, snapshot });
    const { unresolved_threads: _, ...partial } = snapshot;
    expect(Value.Check(PullRequestSnapshotSchema, partial)).toBe(false);
    expect(validatePullRequestSnapshot(partial)).toEqual({
      ok: false,
      reason: "repository.invalid_pull_request_snapshot",
    });
  });
});
