import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { AttemptSchema, ClaimSchema, validateAttemptAccounting } from "./attempt-record.js";

const runningAttempt = {
  attempt_number: 1,
  change_class: "standard",
  compute_profile: "standard",
  config_snapshot_id: "config-1",
  cost_usd: 0.25,
  ended_at: null,
  failure_class: null,
  id: "attempt-1",
  input_tokens: 100,
  model: "provider-model",
  output_tokens: 50,
  price_table_version: "prices-1",
  reasoning_effort: "medium",
  role: "implementation",
  routing_reasons: ["classification.standard"],
  started_at: "2026-07-13T10:00:00Z",
  status: "running",
  terminal_result_id: null,
  total_tokens: 150,
  work_ref: { issue_id: "issue-1" },
  workspace_path: "/tmp/work/issue-1",
};

describe("attempt records", () => {
  it("keeps open attempts without an end time or terminal result", () => {
    expect(Value.Check(AttemptSchema, runningAttempt)).toBe(true);
    expect(
      Value.Check(AttemptSchema, {
        ...runningAttempt,
        terminal_result_id: "result-1",
      }),
    ).toBe(false);
  });

  it("requires one terminal result and end time when closed", () => {
    expect(
      Value.Check(AttemptSchema, {
        ...runningAttempt,
        ended_at: "2026-07-13T10:01:00Z",
        status: "closed",
        terminal_result_id: "result-1",
      }),
    ).toBe(true);
    expect(Value.Check(AttemptSchema, { ...runningAttempt, status: "closed" })).toBe(false);
  });

  it("validates absolute token accounting", () => {
    expect(validateAttemptAccounting(runningAttempt)).toEqual({ ok: true });
    expect(validateAttemptAccounting({ ...runningAttempt, total_tokens: 151 })).toEqual({
      ok: false,
      reason: "attempt.token_total_mismatch",
    });
  });
});

describe("claim records", () => {
  const common = {
    acquired_at: "2026-07-13T10:00:00Z",
    approval_request_id: null,
    blocker_predicate: null,
    holder: "service-run-1",
    last_comment_cursor: null,
    origin_stage: "Todo",
    question_id: null,
    reason: "dispatch",
    retry_due_at: null,
    updated_at: "2026-07-13T10:00:00Z",
    work_ref: { issue_id: "issue-1" },
  };

  it("requires an expiry only for Running leases", () => {
    expect(
      Value.Check(ClaimSchema, {
        ...common,
        expires_at: "2026-07-13T10:02:00Z",
        mode: "Running",
      }),
    ).toBe(true);
    expect(Value.Check(ClaimSchema, { ...common, expires_at: null, mode: "Running" })).toBe(false);
    expect(Value.Check(ClaimSchema, { ...common, expires_at: null, mode: "Ready" })).toBe(true);
    expect(
      Value.Check(ClaimSchema, {
        ...common,
        expires_at: "2026-07-13T10:02:00Z",
        mode: "Ready",
      }),
    ).toBe(false);
  });
});
