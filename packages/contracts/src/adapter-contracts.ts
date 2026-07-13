import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { IssueSchema } from "./entity-records.js";

const NonEmptyString = Type.String({ minLength: 1 });
const NullableString = Type.Union([NonEmptyString, Type.Null()]);
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
const Sha = Type.String({ minLength: 7, pattern: "^[a-fA-F0-9]+$" });

export const AgentErrorCodeSchema = Type.Union([
  Type.Literal("agent_not_found"),
  Type.Literal("protocol_incompatible"),
  Type.Literal("invalid_workspace_cwd"),
  Type.Literal("auth_failed"),
  Type.Literal("response_timeout"),
  Type.Literal("turn_timeout"),
  Type.Literal("stalled"),
  Type.Literal("process_exit"),
  Type.Literal("turn_failed"),
  Type.Literal("turn_cancelled"),
  Type.Literal("turn_input_required"),
  Type.Literal("token_cap_exceeded"),
  Type.Literal("usd_cap_exceeded"),
  Type.Literal("result_missing"),
  Type.Literal("result_invalid"),
  Type.Literal("overloaded"),
]);
export type AgentErrorCode = Static<typeof AgentErrorCodeSchema>;

export const AGENT_ERROR_FAILURE_CLASS = {
  agent_not_found: "configuration",
  protocol_incompatible: "configuration",
  invalid_workspace_cwd: "policy",
  auth_failed: "auth",
  response_timeout: "agent_process",
  turn_timeout: "agent_process",
  stalled: "agent_process",
  process_exit: "agent_process",
  turn_failed: "agent_process",
  turn_cancelled: "agent_process",
  turn_input_required: "task",
  token_cap_exceeded: "budget_exhausted",
  usd_cap_exceeded: "budget_exhausted",
  result_missing: "agent_process",
  result_invalid: "agent_process",
  overloaded: "infrastructure",
} as const satisfies Readonly<
  Record<
    AgentErrorCode,
    | "configuration"
    | "policy"
    | "auth"
    | "agent_process"
    | "task"
    | "budget_exhausted"
    | "infrastructure"
  >
>;

const CommonEventProperties = {
  attempt_id: NonEmptyString,
  session_id: NullableString,
  timestamp: NonEmptyString,
};

const TurnEndEventSchemas = ["turn_completed", "turn_failed", "turn_cancelled"].map((event) =>
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal(event),
      provider_reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
);

const ActionEventSchemas = ["action_started", "action_completed", "action_failed"].map((event) =>
  Type.Object(
    {
      ...CommonEventProperties,
      action_id: NonEmptyString,
      cwd: NonEmptyString,
      event: Type.Literal(event),
      exit_code: Type.Union([Type.Integer(), Type.Null()]),
      kind: Type.Union([
        Type.Literal("command"),
        Type.Literal("file_change"),
        Type.Literal("tool_call"),
        Type.Literal("network_fetch"),
        Type.Literal("other"),
      ]),
      output_ref: NullableString,
      result_status: NullableString,
      summary: NonEmptyString,
    },
    { additionalProperties: false },
  ),
);

export const AgentEventSchema = Type.Union([
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("session_started"),
      model: NonEmptyString,
      reasoning_effort: NonEmptyString,
      thread_id: NonEmptyString,
      turn_id: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      error_code: AgentErrorCodeSchema,
      event: Type.Literal("startup_failed"),
    },
    { additionalProperties: false },
  ),
  ...TurnEndEventSchemas,
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("turn_input_required"),
      provider_reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  ...ActionEventSchemas,
  Type.Object(
    {
      ...CommonEventProperties,
      action_kind: NonEmptyString,
      approval_id: NonEmptyString,
      event: Type.Literal("approval_requested"),
      scope: NonEmptyString,
      summary: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      approval_id: NonEmptyString,
      event: Type.Literal("approval_auto_approved"),
      policy_rule_id: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("unsupported_tool_call"),
      tool_name: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      billable_categories: Type.Record(Type.String(), NonNegativeNumber),
      cost_usd: Type.Union([NonNegativeNumber, Type.Null()]),
      event: Type.Literal("token_usage"),
      input_tokens: NonNegativeInteger,
      output_tokens: NonNegativeInteger,
      total_tokens: NonNegativeInteger,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("rate_limit"),
      snapshot: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("terminal_result_reported"),
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("notification"),
      message: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventProperties,
      event: Type.Literal("malformed"),
      message_ref: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);
export type AgentEvent = Static<typeof AgentEventSchema>;

const ProfileResolutionSchema = Type.Object(
  { model: NonEmptyString, reasoning_effort: NonEmptyString },
  { additionalProperties: false },
);

const ModelPriceSchema = Type.Object(
  {
    cached_input_per_million_usd: Type.Optional(NonNegativeNumber),
    input_per_million_usd: NonNegativeNumber,
    output_per_million_usd: NonNegativeNumber,
  },
  { additionalProperties: false },
);

export const AgentAdapterManifestSchema = Type.Object(
  {
    adapter_version: NonEmptyString,
    capabilities: Type.Array(NonEmptyString, { uniqueItems: true }),
    price_table: Type.Union([
      Type.Object(
        {
          models: Type.Record(Type.String(), ModelPriceSchema),
          version: NonEmptyString,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    profiles: Type.Object(
      {
        deep: ProfileResolutionSchema,
        economy: ProfileResolutionSchema,
        standard: ProfileResolutionSchema,
      },
      { additionalProperties: false },
    ),
    protocol: Type.Object(
      {
        maximum: NonEmptyString,
        minimum: NonEmptyString,
        schema_hash: NonEmptyString,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type AgentAdapterManifest = Static<typeof AgentAdapterManifestSchema>;

export const TrackerIssuePageSchema = Type.Object(
  {
    cursor: NullableString,
    has_more: Type.Boolean(),
    items: Type.Array(IssueSchema),
  },
  { additionalProperties: false },
);
export type TrackerIssuePage = Static<typeof TrackerIssuePageSchema>;

export type CompletePageValidation =
  | { ok: true }
  | { ok: false; reason: "pagination.invalid" | "pagination.missing_cursor" };

export function validateCompletePage(value: unknown): CompletePageValidation {
  if (!Value.Check(TrackerIssuePageSchema, value)) {
    return { ok: false, reason: "pagination.invalid" };
  }
  if (value.has_more && value.cursor === null) {
    return { ok: false, reason: "pagination.missing_cursor" };
  }
  return { ok: true };
}

const CheckSchema = Type.Object(
  {
    conclusion: NullableString,
    name: NonEmptyString,
    required_source: Type.Optional(
      Type.Union([Type.Literal("configured"), Type.Literal("protection"), Type.Literal("union")]),
    ),
    status: NonEmptyString,
    target_sha: Sha,
    url: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PullRequestSnapshotSchema = Type.Object(
  {
    base_ref: NonEmptyString,
    checks: Type.Array(CheckSchema),
    head_sha: Sha,
    is_draft: Type.Boolean(),
    mergeable: Type.Union([Type.Boolean(), Type.Null()]),
    observed_base_sha: Sha,
    post_merge_checks: Type.Array(CheckSchema),
    pr_number: Type.Integer({ minimum: 1 }),
    pr_state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
    pr_url: NonEmptyString,
    required_check_source: Type.Union([
      Type.Literal("configured"),
      Type.Literal("protection"),
      Type.Literal("union"),
    ]),
    review_decision: Type.Union([
      Type.Literal("approved"),
      Type.Literal("changes_requested"),
      Type.Literal("none"),
    ]),
    reviews: Type.Array(
      Type.Object(
        {
          author: NonEmptyString,
          commit_sha: Sha,
          state: NonEmptyString,
          submitted_at: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
    unresolved_threads: Type.Array(
      Type.Object(
        {
          author: NonEmptyString,
          commit_sha: Sha,
          id: NonEmptyString,
          is_outdated: Type.Boolean(),
          url: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PullRequestSnapshot = Static<typeof PullRequestSnapshotSchema>;

export type PullRequestSnapshotValidation =
  | { ok: true; snapshot: PullRequestSnapshot }
  | { ok: false; reason: "repository.invalid_pull_request_snapshot" };

export function validatePullRequestSnapshot(value: unknown): PullRequestSnapshotValidation {
  return Value.Check(PullRequestSnapshotSchema, value)
    ? { ok: true, snapshot: value }
    : { ok: false, reason: "repository.invalid_pull_request_snapshot" };
}
