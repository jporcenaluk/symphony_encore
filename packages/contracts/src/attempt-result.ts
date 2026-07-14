import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const Sha = Type.String({ minLength: 7, pattern: "^[a-fA-F0-9]+$" });

export const WorkRefSchema = Type.Union([
  Type.Object({ issue_id: NonEmptyString }, { additionalProperties: false }),
  Type.Object({ system_job_id: NonEmptyString }, { additionalProperties: false }),
]);
export type WorkRef = Static<typeof WorkRefSchema>;

export const EvidenceRefSchema = Type.Union([
  Type.Object(
    {
      command: NonEmptyString,
      exit_code: Type.Integer(),
      kind: Type.Literal("command"),
      result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("file"), path: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("commit"), sha: Sha }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("pull_request"),
      number: Type.Integer({ minimum: 1 }),
      url: Type.String({ format: "uri" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      conclusion: NonEmptyString,
      kind: Type.Literal("check"),
      name: NonEmptyString,
      url: Type.Optional(Type.String({ format: "uri" })),
    },
    { additionalProperties: false },
  ),
]);
export type EvidenceRef = Static<typeof EvidenceRefSchema>;

export const OperatorQuestionSchema = Type.Object(
  {
    default: NonEmptyString,
    options: Type.Array(NonEmptyString, { minItems: 2, uniqueItems: true }),
    text: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OperatorQuestion = Static<typeof OperatorQuestionSchema>;

export const HandoffSchema = Type.Object(
  {
    acceptance_criteria: Type.Array(NonEmptyString),
    commands: Type.Array(
      Type.Object(
        { command: NonEmptyString, exit_code: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
    decisions_fixed: Type.Array(NonEmptyString),
    files_changed: Type.Array(NonEmptyString),
    goal: NonEmptyString,
    open_items: Type.Array(NonEmptyString),
    revision: NonEmptyString,
  },
  { additionalProperties: false },
);
export type Handoff = Static<typeof HandoffSchema>;

export function isHandoff(value: unknown): value is Handoff {
  return Value.Check(HandoffSchema, value);
}

export const ActionRequestSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("update_issue_lane"), lane: NonEmptyString, reason: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("publish_branch"), expected_base_sha: Sha },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("ensure_pull_request"), base_ref: NonEmptyString },
    { additionalProperties: false },
  ),
]);
export type ActionRequest = Static<typeof ActionRequestSchema>;

export const AgentVerificationSchema = Type.Object(
  {
    command: NonEmptyString,
    exit_code: Type.Integer(),
    result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error")]),
    stderr_ref: Type.Optional(NonEmptyString),
    stdout_ref: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type AgentVerification = Static<typeof AgentVerificationSchema>;

const CommonOutcomeProperties = {
  actions_requested: Type.Array(ActionRequestSchema),
  confusions: Type.Array(NonEmptyString),
  evidence: Type.Array(EvidenceRefSchema),
  handoff: HandoffSchema,
  summary: NonEmptyString,
};

const CompletedOutcomeSchema = Type.Object(
  {
    ...CommonOutcomeProperties,
    status: Type.Literal("completed"),
    verification: AgentVerificationSchema,
  },
  { additionalProperties: false },
);

const NeedsInputOutcomeSchema = Type.Object(
  {
    ...CommonOutcomeProperties,
    question: OperatorQuestionSchema,
    status: Type.Literal("needs_input"),
  },
  { additionalProperties: false },
);

const OtherOutcomeSchema = Type.Union(
  ["plan_ready", "needs_rework", "blocked", "no_progress", "budget_exhausted", "failed"].map(
    (status) =>
      Type.Object(
        {
          ...CommonOutcomeProperties,
          status: Type.Literal(status),
        },
        { additionalProperties: false },
      ),
  ),
);

export const ImplementationOutcomeSchema = Type.Union([
  CompletedOutcomeSchema,
  NeedsInputOutcomeSchema,
  OtherOutcomeSchema,
]);
export type ImplementationOutcome = Static<typeof ImplementationOutcomeSchema>;

export function isImplementationOutcome(value: unknown): value is ImplementationOutcome {
  return Value.Check(ImplementationOutcomeSchema, value);
}

export type QuestionValidation =
  | { ok: true }
  | { ok: false; reason: "question.invalid" | "question.default_not_in_options" };

export function validateOperatorQuestion(value: unknown): QuestionValidation {
  if (!Value.Check(OperatorQuestionSchema, value)) {
    return { ok: false, reason: "question.invalid" };
  }
  if (!value.options.includes(value.default)) {
    return { ok: false, reason: "question.default_not_in_options" };
  }
  return { ok: true };
}
