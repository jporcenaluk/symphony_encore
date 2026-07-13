import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  IssueSchema,
  MutationAuthorizationSchema,
  ReviewSetSchema,
  StageTransitionSchema,
  SystemJobSchema,
  UsageSampleSchema,
  validateIssueNormalization,
  validateReviewSet,
} from "./entity-records.js";

const workRef = { issue_id: "issue-1" };

describe("normalized issue contract", () => {
  const issue = {
    acceptance_criteria: ["The result is durable"],
    assignee_id: null,
    blocked_by: [{ id: "issue-0", state: "Done" }],
    created_at: "2026-07-13T10:00:00Z",
    description: "Implement the durable path",
    id: "issue-1",
    identifier: "WS-1",
    labels: ["backend", "risk:auth"],
    priority: 1,
    repo_name: "wheelsparrow",
    repo_owner: "jporc",
    state: "Todo",
    title: "Implement persistence",
    updated_at: "2026-07-13T10:01:00Z",
    url: "https://github.com/jporc/wheelsparrow/issues/1",
  };

  it("accepts complete normalized records and rejects non-lowercase labels", () => {
    expect(Value.Check(IssueSchema, issue)).toBe(true);
    expect(validateIssueNormalization(issue)).toEqual({ ok: true });
    expect(validateIssueNormalization({ ...issue, labels: ["Backend"] })).toEqual({
      ok: false,
      reason: "issue.labels_not_lowercase",
    });
  });
});

describe("cross-record ownership contracts", () => {
  const commonJob = {
    acceptance_criteria: ["A proposed rule change is reviewed"],
    config_snapshot_id: "config-1",
    cost_usd: 0,
    created_at: "2026-07-13T10:00:00Z",
    ended_at: null,
    final_result_id: null,
    goal: "Synthesize lessons",
    id: "job-1",
    input_tokens: 0,
    output_tokens: 0,
    repository: "jporc/wheelsparrow",
    started_at: null,
    status: "queued",
    workspace_path: "/tmp/work/_system/synthesis-job-1",
  };

  it("requires repair jobs, but not synthesis jobs, to name a parent", () => {
    expect(
      Value.Check(SystemJobSchema, {
        ...commonJob,
        kind: "synthesis",
        parent_work_ref: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemJobSchema, {
        ...commonJob,
        kind: "repair",
        parent_work_ref: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemJobSchema, {
        ...commonJob,
        kind: "repair",
        parent_work_ref: workRef,
      }),
    ).toBe(true);
  });

  it("assigns each usage sample to exactly one attempt or system job", () => {
    const sample = {
      attempt_id: "attempt-1",
      billable_categories: { input: 100 },
      cost_usd: 0.01,
      derived_input_tokens: 100,
      derived_output_tokens: 20,
      derived_total_tokens: 120,
      id: "usage-1",
      input_tokens: 100,
      output_tokens: 20,
      service_run_id: "run-1",
      system_job_id: null,
      timestamp: "2026-07-13T10:00:00Z",
      total_tokens: 120,
      work_ref: workRef,
    };
    expect(Value.Check(UsageSampleSchema, sample)).toBe(true);
    expect(
      Value.Check(UsageSampleSchema, {
        ...sample,
        system_job_id: "job-1",
      }),
    ).toBe(false);
  });
});

describe("durable decision contracts", () => {
  const commonAuthorization = {
    action: "update_issue_lane",
    actor_id: "scheduler",
    actor_kind: "orchestrator_policy",
    attempt_role: "implementation",
    authorized_at: "2026-07-13T10:00:00Z",
    config_snapshot_id: "config-1",
    decision_rule_ids: ["lane.implementation_start"],
    expires_at: "2026-07-13T10:01:00Z",
    id: "auth-1",
    idempotency_key: "intent-1",
    intent_id: "intent-1",
    observed_state_ref: "tracker-snapshot-1",
    operator_capability: null,
    service_run_id: "run-1",
    target: "issue-1:lane",
    target_revision: "revision-1",
  };

  it("requires work scope to name work and fleet scope not to", () => {
    expect(
      Value.Check(MutationAuthorizationSchema, {
        ...commonAuthorization,
        scope: "work",
        work_ref: workRef,
      }),
    ).toBe(true);
    expect(
      Value.Check(MutationAuthorizationSchema, {
        ...commonAuthorization,
        scope: "work",
        work_ref: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(MutationAuthorizationSchema, {
        ...commonAuthorization,
        attempt_role: null,
        scope: "fleet",
        work_ref: null,
      }),
    ).toBe(true);
  });

  it("represents one open stage or one closed stage without partial timing", () => {
    const stage = {
      attempt_id: null,
      confirmed_external_revision: "revision-1",
      entered_at: "2026-07-13T10:00:00Z",
      from_stage: null,
      id: "stage-1",
      reason: "baseline",
      timestamp_source: "tracker",
      to_stage: "Todo",
      work_ref: workRef,
    };
    expect(
      Value.Check(StageTransitionSchema, {
        ...stage,
        duration_ms: null,
        exited_at: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(StageTransitionSchema, {
        ...stage,
        duration_ms: 1000,
        exited_at: null,
      }),
    ).toBe(false);
  });
});

describe("ReviewSet invariants", () => {
  const ordinary = {
    carried_from_review_set_id: null,
    carry_forward_guard_decision_id: null,
    created_at: "2026-07-13T10:00:00Z",
    decision: "approve",
    guard_decision_ids: ["guard-1"],
    id: "review-set-1",
    patch_identity: "patch-1",
    required_reviewer_roles: ["integrative_review"],
    required_specialist_names: [],
    review_record_ids: ["review-1"],
    target_base_sha: "aaaaaaa",
    target_sha: "bbbbbbb",
    unresolved_blocking_finding_ids: [],
    verification_record_id: "verification-1",
    work_ref: workRef,
  };

  it("requires both carry-forward links or neither", () => {
    expect(Value.Check(ReviewSetSchema, ordinary)).toBe(true);
    expect(validateReviewSet(ordinary)).toEqual({ ok: true });
    expect(
      validateReviewSet({
        ...ordinary,
        carried_from_review_set_id: "review-set-0",
      }),
    ).toEqual({ ok: false, reason: "review_set.incomplete_carry_forward" });
  });

  it("does not allow aggregate approval with unresolved blocking findings", () => {
    expect(
      validateReviewSet({
        ...ordinary,
        unresolved_blocking_finding_ids: ["finding-1"],
      }),
    ).toEqual({ ok: false, reason: "review_set.approval_has_blocking_findings" });
  });
});
