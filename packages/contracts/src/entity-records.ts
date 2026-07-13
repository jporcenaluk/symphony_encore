import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AttemptRoleSchema } from "./attempt-record.js";
import { EvidenceRefSchema, WorkRefSchema } from "./attempt-result.js";

const NonEmptyString = Type.String({ minLength: 1 });
const NullableString = Type.Union([NonEmptyString, Type.Null()]);
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
const Sha = Type.String({ minLength: 7, pattern: "^[a-fA-F0-9]+$" });

export const IssueLaneSchema = Type.Union([
  Type.Literal("Backlog"),
  Type.Literal("Todo"),
  Type.Literal("In Progress"),
  Type.Literal("Review"),
  Type.Literal("Human"),
  Type.Literal("Done"),
]);

export const IssueSchema = Type.Object(
  {
    acceptance_criteria: Type.Array(NonEmptyString),
    assignee_id: NullableString,
    blocked_by: Type.Array(
      Type.Object({ id: NonEmptyString, state: NonEmptyString }, { additionalProperties: false }),
    ),
    created_at: NonEmptyString,
    description: Type.String(),
    id: NonEmptyString,
    identifier: NonEmptyString,
    labels: Type.Array(NonEmptyString, { uniqueItems: true }),
    priority: Type.Union([Type.Integer(), Type.Null()]),
    repo_name: NonEmptyString,
    repo_owner: NonEmptyString,
    state: IssueLaneSchema,
    title: NonEmptyString,
    updated_at: NonEmptyString,
    url: NonEmptyString,
  },
  { additionalProperties: false },
);
export type Issue = Static<typeof IssueSchema>;

export type IssueNormalizationValidation =
  | { ok: true }
  | { ok: false; reason: "issue.invalid" | "issue.labels_not_lowercase" };

export function validateIssueNormalization(value: unknown): IssueNormalizationValidation {
  if (!Value.Check(IssueSchema, value)) return { ok: false, reason: "issue.invalid" };
  if (value.labels.some((label) => label !== label.toLocaleLowerCase("en-US"))) {
    return { ok: false, reason: "issue.labels_not_lowercase" };
  }
  return { ok: true };
}

const CommonSystemJobProperties = {
  acceptance_criteria: Type.Array(NonEmptyString),
  config_snapshot_id: NonEmptyString,
  cost_usd: Type.Union([NonNegativeNumber, Type.Null()]),
  created_at: NonEmptyString,
  ended_at: NullableString,
  final_result_id: NullableString,
  goal: NonEmptyString,
  id: NonEmptyString,
  input_tokens: NonNegativeInteger,
  output_tokens: NonNegativeInteger,
  repository: NonEmptyString,
  started_at: NullableString,
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("review"),
    Type.Literal("merge"),
    Type.Literal("rework"),
    Type.Literal("human"),
    Type.Literal("budget_exhausted"),
    Type.Literal("failed"),
    Type.Literal("done"),
  ]),
  workspace_path: NonEmptyString,
};

export const SystemJobSchema = Type.Union([
  Type.Object(
    {
      ...CommonSystemJobProperties,
      kind: Type.Literal("synthesis"),
      parent_work_ref: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonSystemJobProperties,
      kind: Type.Literal("repair"),
      parent_work_ref: WorkRefSchema,
    },
    { additionalProperties: false },
  ),
]);
export type SystemJob = Static<typeof SystemJobSchema>;

const ConfigurationSourceMetadataSchema = Type.Object(
  {
    acknowledgment_state: NonEmptyString,
    reload_state: NonEmptyString,
    source: Type.Union([
      Type.Literal("default"),
      Type.Literal("workflow"),
      Type.Literal("operator_override"),
      Type.Literal("bootstrap"),
    ]),
    version: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ConfigurationSnapshotSchema = Type.Object(
  {
    acknowledgment_state: Type.Record(Type.String(), NonEmptyString),
    adapter_versions: Type.Record(Type.String(), NonEmptyString),
    created_at: NonEmptyString,
    effective_config: Type.Record(Type.String(), Type.Unknown()),
    id: NonEmptyString,
    operator_override_revision: NonNegativeInteger,
    per_key_metadata: Type.Record(Type.String(), ConfigurationSourceMetadataSchema),
    prompt_hash: NonEmptyString,
    restart_state: Type.Record(Type.String(), NonEmptyString),
    workflow_source_hash: NonEmptyString,
  },
  { additionalProperties: false },
);
export type ConfigurationSnapshot = Static<typeof ConfigurationSnapshotSchema>;

const CommonUsageSampleProperties = {
  billable_categories: Type.Record(Type.String(), NonNegativeNumber),
  cost_usd: Type.Union([NonNegativeNumber, Type.Null()]),
  derived_input_tokens: NonNegativeInteger,
  derived_output_tokens: NonNegativeInteger,
  derived_total_tokens: NonNegativeInteger,
  id: NonEmptyString,
  input_tokens: NonNegativeInteger,
  output_tokens: NonNegativeInteger,
  service_run_id: NonEmptyString,
  timestamp: NonEmptyString,
  total_tokens: NonNegativeInteger,
  work_ref: WorkRefSchema,
};

export const UsageSampleSchema = Type.Union([
  Type.Object(
    {
      ...CommonUsageSampleProperties,
      attempt_id: NonEmptyString,
      system_job_id: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonUsageSampleProperties,
      attempt_id: Type.Null(),
      system_job_id: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);
export type UsageSample = Static<typeof UsageSampleSchema>;

const CommonMutationAuthorizationProperties = {
  action: NonEmptyString,
  actor_id: NonEmptyString,
  actor_kind: Type.Union([Type.Literal("orchestrator_policy"), Type.Literal("operator")]),
  attempt_role: Type.Union([AttemptRoleSchema, Type.Null()]),
  authorized_at: NonEmptyString,
  config_snapshot_id: NonEmptyString,
  decision_rule_ids: Type.Array(NonEmptyString),
  expires_at: NonEmptyString,
  id: NonEmptyString,
  idempotency_key: NonEmptyString,
  intent_id: NonEmptyString,
  observed_state_ref: NonEmptyString,
  operator_capability: NullableString,
  service_run_id: NonEmptyString,
  target: NonEmptyString,
  target_revision: NullableString,
};

export const MutationAuthorizationSchema = Type.Union([
  Type.Object(
    {
      ...CommonMutationAuthorizationProperties,
      scope: Type.Literal("work"),
      work_ref: WorkRefSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonMutationAuthorizationProperties,
      scope: Type.Literal("fleet"),
      work_ref: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);
export type MutationAuthorization = Static<typeof MutationAuthorizationSchema>;

const CommonStageTransitionProperties = {
  attempt_id: NullableString,
  confirmed_external_revision: NullableString,
  entered_at: NonEmptyString,
  from_stage: NullableString,
  id: NonEmptyString,
  reason: NonEmptyString,
  timestamp_source: Type.Union([
    Type.Literal("receipt"),
    Type.Literal("tracker"),
    Type.Literal("observed_estimate"),
  ]),
  to_stage: NonEmptyString,
  work_ref: WorkRefSchema,
};

export const StageTransitionSchema = Type.Union([
  Type.Object(
    {
      ...CommonStageTransitionProperties,
      duration_ms: Type.Null(),
      exited_at: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonStageTransitionProperties,
      duration_ms: NonNegativeInteger,
      exited_at: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);
export type StageTransition = Static<typeof StageTransitionSchema>;

export const ReviewDecisionSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("needs_rework"),
  Type.Literal("needs_human"),
  Type.Literal("blocked"),
]);

const SeveritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const DurableReviewFindingSchema = Type.Object(
  {
    behavior: NonEmptyString,
    blocking: Type.Boolean(),
    disposition: NonEmptyString,
    evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
    id: NonEmptyString,
    severity: SeveritySchema,
  },
  { additionalProperties: false },
);

export const ReviewRecordSchema = Type.Object(
  {
    attempt_id: NonEmptyString,
    created_at: NonEmptyString,
    decision: ReviewDecisionSchema,
    findings: Type.Array(DurableReviewFindingSchema),
    id: NonEmptyString,
    patch_identity: NonEmptyString,
    reviewer_role: AttemptRoleSchema,
    target_base_sha: Sha,
    target_sha: Sha,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type ReviewRecord = Static<typeof ReviewRecordSchema>;

export const GuardDecisionSchema = Type.Object(
  {
    created_at: NonEmptyString,
    evidence: Type.Array(EvidenceRefSchema),
    id: NonEmptyString,
    reason_code: NonEmptyString,
    requested_transition: NonEmptyString,
    result: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type GuardDecision = Static<typeof GuardDecisionSchema>;

export const LessonSchema = Type.Object(
  {
    created_at: NonEmptyString,
    evidence: Type.Array(EvidenceRefSchema),
    id: NonEmptyString,
    source: Type.Union([
      Type.Literal("guard_denial"),
      Type.Literal("rework"),
      Type.Literal("review_finding"),
      Type.Literal("escaped_defect"),
      Type.Literal("plan_rejection"),
      Type.Literal("tool_failure"),
      Type.Literal("budget_exhausted"),
      Type.Literal("confusion"),
    ]),
    text: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type Lesson = Static<typeof LessonSchema>;

export const RuleSchema = Type.Object(
  {
    citation_count: NonNegativeInteger,
    id: NonEmptyString,
    last_cited_at: NullableString,
    lesson_ids: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
    text: NonEmptyString,
  },
  { additionalProperties: false },
);
export type Rule = Static<typeof RuleSchema>;

export const LiveSessionSchema = Type.Object(
  {
    adapter_version: NonEmptyString,
    attempt_id: NonEmptyString,
    last_event: NonEmptyString,
    last_event_at: NonEmptyString,
    last_input_tokens: NonNegativeInteger,
    last_output_tokens: NonNegativeInteger,
    last_total_tokens: NonNegativeInteger,
    ownership_verified_at: NullableString,
    process_group_id: NonNegativeInteger,
    process_id: NonNegativeInteger,
    protocol_schema_hash: NonEmptyString,
    session_id: NonEmptyString,
    thread_id: NonEmptyString,
    turn_count: NonNegativeInteger,
    turn_id: NullableString,
  },
  { additionalProperties: false },
);
export type LiveSession = Static<typeof LiveSessionSchema>;

export const RetryEntrySchema = Type.Object(
  {
    attempt_id: NonEmptyString,
    created_at: NonEmptyString,
    due_at: NonEmptyString,
    failure_class: NonEmptyString,
    last_error: NonEmptyString,
    max_retries: NonNegativeInteger,
    retry_number: Type.Integer({ minimum: 1 }),
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type RetryEntry = Static<typeof RetryEntrySchema>;

export const ParkedWorkSchema = Type.Object(
  {
    blocker_predicate: NullableString,
    last_checked_at: NonEmptyString,
    origin_stage: NonEmptyString,
    parked_at: NonEmptyString,
    question_id: NullableString,
    reason: NonEmptyString,
    resolved_at: NullableString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type ParkedWork = Static<typeof ParkedWorkSchema>;

export const OperatorQuestionRecordSchema = Type.Object(
  {
    answer: NullableString,
    answered_at: NullableString,
    answered_by: NullableString,
    asked_at: NonEmptyString,
    attempt_id: NonEmptyString,
    comment_cursor: NullableString,
    comment_marker: NonEmptyString,
    default: NonEmptyString,
    id: NonEmptyString,
    options: Type.Array(NonEmptyString, { minItems: 2, uniqueItems: true }),
    reminded_at: NullableString,
    text: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type OperatorQuestionRecord = Static<typeof OperatorQuestionRecordSchema>;

export const AgentApprovalRequestSchema = Type.Object(
  {
    action_kind: NonEmptyString,
    attempt_id: NonEmptyString,
    decided_at: NullableString,
    decided_by: NullableString,
    decision: NullableString,
    expires_at: NonEmptyString,
    id: NonEmptyString,
    requested_at: NonEmptyString,
    scope: NonEmptyString,
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("approved"),
      Type.Literal("denied"),
      Type.Literal("expired"),
    ]),
    summary: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type AgentApprovalRequest = Static<typeof AgentApprovalRequestSchema>;

const SideEffectScopeProperties = {
  action: NonEmptyString,
  attempt_id: NullableString,
  authorization_id: NonEmptyString,
  created_at: NonEmptyString,
  id: NonEmptyString,
  idempotency_key: NonEmptyString,
  request_payload_hash: NonEmptyString,
  service_run_id: NonEmptyString,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("applying"),
    Type.Literal("applied"),
    Type.Literal("failed"),
    Type.Literal("unknown"),
  ]),
  target: NonEmptyString,
  target_revision: NullableString,
  updated_at: NonEmptyString,
};

export const SideEffectIntentSchema = Type.Union([
  Type.Object(
    {
      ...SideEffectScopeProperties,
      scope: Type.Literal("work"),
      work_ref: WorkRefSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...SideEffectScopeProperties,
      scope: Type.Literal("fleet"),
      work_ref: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);
export type SideEffectIntent = Static<typeof SideEffectIntentSchema>;

export const SideEffectReceiptSchema = Type.Object(
  {
    applied_at: NonEmptyString,
    intent_id: NonEmptyString,
    provider_request_id: NonEmptyString,
    response_payload_hash: NonEmptyString,
    result: NonEmptyString,
    result_revision: NullableString,
  },
  { additionalProperties: false },
);
export type SideEffectReceipt = Static<typeof SideEffectReceiptSchema>;

export const OperatorActionSchema = Type.Object(
  {
    action: NonEmptyString,
    auth_subject: NonEmptyString,
    capability: NonEmptyString,
    created_at: NonEmptyString,
    endpoint: NonEmptyString,
    expected_version: Type.Union([NonNegativeInteger, NonEmptyString]),
    id: NonEmptyString,
    idempotency_key: NonEmptyString,
    observed_version: Type.Union([NonNegativeInteger, NonEmptyString]),
    operator_id: NonEmptyString,
    reason: NonEmptyString,
    request_payload_hash: NonEmptyString,
    result: NonEmptyString,
    target: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OperatorAction = Static<typeof OperatorActionSchema>;

export const RepositoryLinkSchema = Type.Object(
  {
    base_ref: NonEmptyString,
    base_sha: Sha,
    branch: NonEmptyString,
    created_at: NonEmptyString,
    cycle: Type.Integer({ minimum: 1 }),
    head_sha: Sha,
    id: NonEmptyString,
    kind: Type.Union([Type.Literal("primary"), Type.Literal("repair")]),
    pull_request_number: Type.Integer({ minimum: 1 }),
    pull_request_url: NonEmptyString,
    repo_name: NonEmptyString,
    repo_owner: NonEmptyString,
    state: NonEmptyString,
    updated_at: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type RepositoryLink = Static<typeof RepositoryLinkSchema>;

const PlanAcceptanceCriterionSchema = Type.Object(
  {
    criterion_id: NonEmptyString,
    criterion_text: NonEmptyString,
    planned_evidence: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PlanSchema = Type.Object(
  {
    acceptance_criteria: Type.Array(PlanAcceptanceCriterionSchema, { minItems: 1 }),
    approach: NonEmptyString,
    approved_by_attempt_id: NullableString,
    created_at: NonEmptyString,
    created_by_attempt_id: NonEmptyString,
    estimated_changed_lines: NonNegativeInteger,
    estimated_files: NonNegativeInteger,
    id: NonEmptyString,
    proposed_paths: Type.Array(NonEmptyString),
    revision: Type.Integer({ minimum: 1 }),
    risk_facts: Type.Array(NonEmptyString, { uniqueItems: true }),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("validated"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
      Type.Literal("superseded"),
    ]),
    validated_at: NullableString,
    verification_commands: Type.Array(NonEmptyString, { minItems: 1 }),
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type Plan = Static<typeof PlanSchema>;

export const ServiceRunSchema = Type.Object(
  {
    end_reason: NullableString,
    ended_at: NullableString,
    host_id: NonEmptyString,
    id: NonEmptyString,
    service_version: NonEmptyString,
    start_reason: NonEmptyString,
    started_at: NonEmptyString,
    startup_config_snapshot_id: NonEmptyString,
    status: Type.Union([
      Type.Literal("starting"),
      Type.Literal("recovering"),
      Type.Literal("ready"),
      Type.Literal("stopped"),
      Type.Literal("interrupted"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);
export type ServiceRun = Static<typeof ServiceRunSchema>;

export const LogRecordSchema = Type.Object(
  {
    attempt_id: NullableString,
    event_name: NonEmptyString,
    id: NonEmptyString,
    level: Type.Union([
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
    ]),
    message: NonEmptyString,
    service_run_id: NonEmptyString,
    session_id: NullableString,
    stage_transition_id: NullableString,
    structured_fields: Type.Record(Type.String(), Type.Unknown()),
    timestamp: NonEmptyString,
    work_ref: Type.Union([WorkRefSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type LogRecord = Static<typeof LogRecordSchema>;

const CommonEventRecordProperties = {
  change_class: Type.Union([
    Type.Literal("trivial"),
    Type.Literal("standard"),
    Type.Literal("high_risk"),
    Type.Null(),
  ]),
  cost_usd: Type.Union([NonNegativeNumber, Type.Null()]),
  cursor: Type.Integer({ minimum: 1 }),
  event_name: NonEmptyString,
  id: NonEmptyString,
  payload: Type.Record(Type.String(), Type.Unknown()),
  reason_code: NonEmptyString,
  result: NonEmptyString,
  service_run_id: NonEmptyString,
  timestamp: NonEmptyString,
};

export const EventRecordSchema = Type.Union([
  Type.Object(
    {
      ...CommonEventRecordProperties,
      attempt_id: NonEmptyString,
      compute_profile: Type.Union([
        Type.Literal("economy"),
        Type.Literal("standard"),
        Type.Literal("deep"),
      ]),
      work_ref: WorkRefSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonEventRecordProperties,
      attempt_id: Type.Null(),
      compute_profile: Type.Null(),
      work_ref: Type.Union([WorkRefSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);
export type EventRecord = Static<typeof EventRecordSchema>;

export const BudgetLedgerSchema = Type.Object(
  {
    adjustment: Type.Number(),
    base_limit: NonNegativeNumber,
    consumed: NonNegativeNumber,
    effective_limit: NonNegativeNumber,
    overrun: NonNegativeNumber,
    remaining: NonNegativeNumber,
    reserved: NonNegativeNumber,
    scope: Type.Union([
      Type.Literal("attempt"),
      Type.Literal("issue"),
      Type.Literal("rolling_24h"),
    ]),
    scope_id: NonEmptyString,
    unit: Type.Union([Type.Literal("tokens"), Type.Literal("usd")]),
    updated_at: NonEmptyString,
    version: NonNegativeInteger,
  },
  { additionalProperties: false },
);
export type BudgetLedger = Static<typeof BudgetLedgerSchema>;

const BudgetAmountsSchema = Type.Object(
  {
    tokens: NonNegativeNumber,
    usd: Type.Union([NonNegativeNumber, Type.Null()]),
  },
  { additionalProperties: false },
);

export const BudgetReservationSchema = Type.Object(
  {
    actual_amounts: BudgetAmountsSchema,
    attempt_id: NullableString,
    created_at: NonEmptyString,
    estimated_amounts: BudgetAmountsSchema,
    id: NonEmptyString,
    ledger_refs: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
    released_at: NullableString,
    status: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("settled"),
      Type.Literal("released"),
      Type.Literal("overrun"),
    ]),
    system_job_id: NullableString,
    updated_at: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type BudgetReservation = Static<typeof BudgetReservationSchema>;

export const BudgetAdjustmentSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("set_limit"),
      Type.Literal("add_allowance"),
      Type.Literal("start_new_allowance_epoch"),
    ]),
    amount: Type.Number(),
    created_at: NonEmptyString,
    id: NonEmptyString,
    ledger_scope_id: NonEmptyString,
    ledger_scope: Type.Union([
      Type.Literal("attempt"),
      Type.Literal("issue"),
      Type.Literal("rolling_24h"),
    ]),
    ledger_unit: Type.Union([Type.Literal("tokens"), Type.Literal("usd")]),
    new_version: Type.Integer({ minimum: 1 }),
    operator_action_id: NonEmptyString,
    prior_version: NonNegativeInteger,
    reason: NonEmptyString,
  },
  { additionalProperties: false },
);
export type BudgetAdjustment = Static<typeof BudgetAdjustmentSchema>;

export const VerificationRecordSchema = Type.Object(
  {
    attempt_id: NonEmptyString,
    command_hash: NonEmptyString,
    config_snapshot_id: NonEmptyString,
    ended_at: NonEmptyString,
    environment_policy_hash: NonEmptyString,
    exit_code: Type.Integer(),
    id: NonEmptyString,
    result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error")]),
    started_at: NonEmptyString,
    stderr_ref: NullableString,
    stdout_ref: NullableString,
    target_revision: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type VerificationRecord = Static<typeof VerificationRecordSchema>;

export const ReviewSetSchema = Type.Object(
  {
    carried_from_review_set_id: NullableString,
    carry_forward_guard_decision_id: NullableString,
    created_at: NonEmptyString,
    decision: ReviewDecisionSchema,
    guard_decision_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
    id: NonEmptyString,
    patch_identity: NonEmptyString,
    required_reviewer_roles: Type.Array(AttemptRoleSchema, { uniqueItems: true }),
    required_specialist_names: Type.Array(NonEmptyString, { uniqueItems: true }),
    review_record_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
    target_base_sha: Sha,
    target_sha: Sha,
    unresolved_blocking_finding_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
    verification_record_id: NonEmptyString,
    work_ref: WorkRefSchema,
  },
  { additionalProperties: false },
);
export type ReviewSet = Static<typeof ReviewSetSchema>;

export type ReviewSetValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "review_set.invalid"
        | "review_set.incomplete_carry_forward"
        | "review_set.approval_has_blocking_findings";
    };

export function validateReviewSet(value: unknown): ReviewSetValidation {
  if (!Value.Check(ReviewSetSchema, value)) return { ok: false, reason: "review_set.invalid" };
  if (
    (value.carried_from_review_set_id === null) !==
    (value.carry_forward_guard_decision_id === null)
  ) {
    return { ok: false, reason: "review_set.incomplete_carry_forward" };
  }
  if (value.decision === "approve" && value.unresolved_blocking_finding_ids.length > 0) {
    return { ok: false, reason: "review_set.approval_has_blocking_findings" };
  }
  return { ok: true };
}
