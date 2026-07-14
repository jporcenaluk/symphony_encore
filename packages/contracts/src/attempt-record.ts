import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { WorkRefSchema } from "./attempt-result.js";

const NonEmptyString = Type.String({ minLength: 1 });
const NullableString = Type.Union([NonEmptyString, Type.Null()]);
const NonNegativeInteger = Type.Integer({ minimum: 0 });

export const AttemptRoleSchema = Type.Union([
  Type.Literal("plan_review"),
  Type.Literal("implementation"),
  Type.Literal("integrative_review"),
  Type.Literal("specialist_review"),
  Type.Literal("adjudication"),
  Type.Literal("synthesis"),
]);

export const FailureClassSchema = Type.Union([
  Type.Literal("infrastructure"),
  Type.Literal("agent_process"),
  Type.Literal("configuration"),
  Type.Literal("auth"),
  Type.Literal("policy"),
  Type.Literal("task"),
]);

const CommonAttemptProperties = {
  attempt_number: Type.Integer({ minimum: 1 }),
  change_class: Type.Union([
    Type.Literal("trivial"),
    Type.Literal("standard"),
    Type.Literal("high_risk"),
  ]),
  compute_profile: Type.Union([
    Type.Literal("economy"),
    Type.Literal("standard"),
    Type.Literal("deep"),
  ]),
  config_snapshot_id: NonEmptyString,
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  failure_class: Type.Union([FailureClassSchema, Type.Null()]),
  id: NonEmptyString,
  input_tokens: NonNegativeInteger,
  model: NonEmptyString,
  output_tokens: NonNegativeInteger,
  price_table_version: NullableString,
  reasoning_effort: NonEmptyString,
  role: AttemptRoleSchema,
  routing_reasons: Type.Array(NonEmptyString),
  started_at: NonEmptyString,
  total_tokens: NonNegativeInteger,
  work_ref: WorkRefSchema,
  workspace_path: NonEmptyString,
};

const OpenAttemptSchema = Type.Union(
  ["created", "running", "awaiting_human"].map((status) =>
    Type.Object(
      {
        ...CommonAttemptProperties,
        ended_at: Type.Null(),
        status: Type.Literal(status),
        terminal_result_id: Type.Null(),
      },
      { additionalProperties: false },
    ),
  ),
);

const ClosedAttemptSchema = Type.Object(
  {
    ...CommonAttemptProperties,
    ended_at: NonEmptyString,
    status: Type.Literal("closed"),
    terminal_result_id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AttemptSchema = Type.Union([OpenAttemptSchema, ClosedAttemptSchema]);
export type Attempt = Static<typeof AttemptSchema>;

const CommonClaimProperties = {
  acquired_at: NonEmptyString,
  approval_request_id: NullableString,
  blocker_predicate: NullableString,
  holder: NonEmptyString,
  last_comment_cursor: NullableString,
  origin_stage: NonEmptyString,
  question_id: NullableString,
  reason: NonEmptyString,
  updated_at: NonEmptyString,
  work_ref: WorkRefSchema,
};

export const ClaimSchema = Type.Union([
  Type.Object(
    {
      ...CommonClaimProperties,
      expires_at: NonEmptyString,
      mode: Type.Literal("Running"),
      retry_due_at: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonClaimProperties,
      expires_at: Type.Null(),
      mode: Type.Literal("Ready"),
      retry_due_at: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonClaimProperties,
      expires_at: Type.Null(),
      mode: Type.Literal("RetryQueued"),
      retry_due_at: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonClaimProperties,
      expires_at: Type.Null(),
      mode: Type.Literal("AwaitingHuman"),
      retry_due_at: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);
export type Claim = Static<typeof ClaimSchema>;

export type AttemptAccountingValidation =
  | { ok: true }
  | { ok: false; reason: "attempt.invalid" | "attempt.token_total_mismatch" };

export function validateAttemptAccounting(value: unknown): AttemptAccountingValidation {
  if (!Value.Check(AttemptSchema, value)) return { ok: false, reason: "attempt.invalid" };
  if (value.total_tokens !== value.input_tokens + value.output_tokens) {
    return { ok: false, reason: "attempt.token_total_mismatch" };
  }
  return { ok: true };
}
