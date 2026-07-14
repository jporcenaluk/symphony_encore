import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  AgentApprovalRequestSchema,
  BudgetAdjustmentSchema,
  BudgetLedgerSchema,
  BudgetReservationSchema,
  ConfigurationSnapshotSchema,
  GuardDecisionSchema,
  LessonSchema,
  LiveSessionSchema,
  LogRecordSchema,
  OperatorActionSchema,
  OperatorQuestionRecordSchema,
  ParkedWorkSchema,
  PlanSchema,
  RepositoryLinkSchema,
  RetryEntrySchema,
  ReviewRecordSchema,
  RuleSchema,
  ServiceRunSchema,
  SideEffectIntentSchema,
  SideEffectReceiptSchema,
  VerificationRecordSchema,
} from "./entity-records.js";

const allDurableSchemas = [
  AgentApprovalRequestSchema,
  BudgetAdjustmentSchema,
  BudgetLedgerSchema,
  BudgetReservationSchema,
  ConfigurationSnapshotSchema,
  GuardDecisionSchema,
  LessonSchema,
  LiveSessionSchema,
  LogRecordSchema,
  OperatorActionSchema,
  OperatorQuestionRecordSchema,
  ParkedWorkSchema,
  PlanSchema,
  RepositoryLinkSchema,
  RetryEntrySchema,
  ReviewRecordSchema,
  RuleSchema,
  ServiceRunSchema,
  SideEffectIntentSchema,
  SideEffectReceiptSchema,
  VerificationRecordSchema,
];

describe("durable record catalog", () => {
  it("defines every remaining Section 3 record as a strict non-empty schema", () => {
    expect(allDurableSchemas).toHaveLength(21);
    for (const schema of allDurableSchemas) {
      expect(Value.Check(schema, {})).toBe(false);
    }
  });

  it("accepts a typed versioned plan", () => {
    expect(
      Value.Check(PlanSchema, {
        acceptance_criteria: [
          {
            criterion_id: "criterion-1",
            criterion_text: "The state survives restart",
            planned_evidence: "Run the restart integration test",
          },
        ],
        approach: "Commit state before applying the external effect",
        approved_by_attempt_id: null,
        created_at: "2026-07-13T10:00:00Z",
        created_by_attempt_id: "attempt-1",
        estimated_changed_lines: 120,
        estimated_files: 3,
        id: "plan-1",
        proposed_paths: ["packages/persistence/src/command.ts"],
        revision: 1,
        risk_facts: ["concurrency"],
        status: "validated",
        validated_at: "2026-07-13T10:01:00Z",
        verification_commands: ["make verify-fast"],
        work_ref: { issue_id: "issue-1" },
      }),
    ).toBe(true);
  });

  it("accepts explicit budget and independent verification records", () => {
    expect(
      Value.Check(BudgetLedgerSchema, {
        adjustment: 100,
        base_limit: 1000,
        consumed: 250,
        effective_limit: 1100,
        overrun: 0,
        remaining: 750,
        reserved: 100,
        scope: "attempt",
        scope_id: "attempt-1",
        unit: "tokens",
        updated_at: "2026-07-13T10:00:00Z",
        version: 2,
      }),
    ).toBe(true);
    expect(
      Value.Check(VerificationRecordSchema, {
        attempt_id: "attempt-1",
        command_hash: "sha256:command",
        config_snapshot_id: "config-1",
        ended_at: "2026-07-13T10:02:00Z",
        environment_policy_hash: "sha256:environment",
        exit_code: 0,
        id: "verification-1",
        result: "passed",
        started_at: "2026-07-13T10:01:00Z",
        stderr_ref: null,
        stdout_ref: "artifact:stdout-1",
        target_revision: "bbbbbbb",
        work_ref: { issue_id: "issue-1" },
      }),
    ).toBe(true);
  });

  it("uses the durable startup recovery and readiness states", () => {
    const serviceRun = {
      end_reason: null,
      ended_at: null,
      host_id: "host-1",
      id: "run-1",
      service_version: "0.0.0",
      start_reason: "startup",
      started_at: "2026-07-13T10:00:00Z",
      startup_config_snapshot_id: "config-1",
      status: "recovering",
    };
    expect(Value.Check(ServiceRunSchema, serviceRun)).toBe(true);
    expect(Value.Check(ServiceRunSchema, { ...serviceRun, status: "ready" })).toBe(true);
    expect(Value.Check(ServiceRunSchema, { ...serviceRun, status: "running" })).toBe(false);
  });
});
