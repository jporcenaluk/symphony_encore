import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { EvidenceRefSchema, HandoffSchema, OperatorQuestionSchema } from "./attempt-result.js";

const NonEmptyString = Type.String({ minLength: 1 });
const Sha = Type.String({ minLength: 7, pattern: "^[a-fA-F0-9]+$" });
const SeveritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const PlanFindingProperties = {
  behavior: NonEmptyString,
  evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  id: NonEmptyString,
  severity: SeveritySchema,
};

export const PlanFindingSchema = Type.Object(
  { ...PlanFindingProperties, blocking: Type.Boolean() },
  { additionalProperties: false },
);
const BlockingPlanFindingSchema = Type.Object({ blocking: Type.Literal(true) });
const NonBlockingPlanFindingSchema = Type.Object(
  { ...PlanFindingProperties, blocking: Type.Literal(false) },
  { additionalProperties: false },
);

const CommonPlanReviewProperties = {
  evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  handoff: HandoffSchema,
  plan_revision: Type.Integer({ minimum: 1 }),
};

export const PlanReviewResultSchema = Type.Union([
  Type.Object(
    {
      ...CommonPlanReviewProperties,
      decision: Type.Literal("approve"),
      findings: Type.Array(NonBlockingPlanFindingSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonPlanReviewProperties,
      decision: Type.Literal("needs_rework"),
      findings: Type.Array(PlanFindingSchema, {
        contains: BlockingPlanFindingSchema,
        minContains: 1,
        minItems: 1,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonPlanReviewProperties,
      decision: Type.Literal("needs_input"),
      findings: Type.Array(PlanFindingSchema),
      question: OperatorQuestionSchema,
    },
    { additionalProperties: false },
  ),
]);
export type PlanReviewResult = Static<typeof PlanReviewResultSchema>;

export function isPlanReviewResult(value: unknown): value is PlanReviewResult {
  return Value.Check(PlanReviewResultSchema, value);
}

const ReviewFindingProperties = {
  behavior: NonEmptyString,
  disposition: NonEmptyString,
  evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  id: NonEmptyString,
  severity: SeveritySchema,
};
export const ReviewFindingSchema = Type.Object(
  { ...ReviewFindingProperties, blocking: Type.Boolean() },
  { additionalProperties: false },
);
const NonBlockingReviewFindingSchema = Type.Object(
  { ...ReviewFindingProperties, blocking: Type.Literal(false) },
  { additionalProperties: false },
);

export const ReviewResultSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("approve"),
      evidence: Type.Array(EvidenceRefSchema),
      findings: Type.Array(NonBlockingReviewFindingSchema),
      target_sha: Sha,
    },
    { additionalProperties: false },
  ),
  ...(["needs_rework", "needs_human", "blocked"] as const).map((decision) =>
    Type.Object(
      {
        decision: Type.Literal(decision),
        evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
        findings: Type.Array(ReviewFindingSchema),
        target_sha: Sha,
      },
      { additionalProperties: false },
    ),
  ),
]);
export type ReviewResult = Static<typeof ReviewResultSchema>;

const ResolutionSchema = Type.Object(
  {
    conflict_id: NonEmptyString,
    evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
    rationale: NonEmptyString,
    rejected_finding_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
    upheld_finding_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const AdjudicationResultSchema = Type.Union([
  Type.Object(
    {
      conflict_ids: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
      decision: Type.Literal("resolve"),
      evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
      resolutions: Type.Array(ResolutionSchema, { minItems: 1 }),
      target_sha: Sha,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      conflict_ids: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
      decision: Type.Literal("needs_human"),
      evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
      question: OperatorQuestionSchema,
      resolutions: Type.Array(ResolutionSchema),
      target_sha: Sha,
    },
    { additionalProperties: false },
  ),
]);
export type AdjudicationResult = Static<typeof AdjudicationResultSchema>;

const RuleChangeSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
    lesson_ids: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
    rationale: NonEmptyString,
    rule_id: NonEmptyString,
    text: NonEmptyString,
  },
  { additionalProperties: false },
);
const CommonSynthesisProperties = {
  cited_lesson_ids: Type.Array(NonEmptyString, { uniqueItems: true }),
  evidence: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  handoff: HandoffSchema,
};

export const SynthesisResultSchema = Type.Union([
  Type.Object(
    {
      ...CommonSynthesisProperties,
      branch: NonEmptyString,
      decision: Type.Literal("propose_changes"),
      pull_request: Type.Object(
        { base_ref: NonEmptyString, title: NonEmptyString },
        { additionalProperties: false },
      ),
      repository_revision: Sha,
      rule_changes: Type.Array(RuleChangeSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonSynthesisProperties,
      decision: Type.Literal("no_change"),
      rule_changes: Type.Array(RuleChangeSchema, { maxItems: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonSynthesisProperties,
      decision: Type.Literal("needs_input"),
      question: OperatorQuestionSchema,
      rule_changes: Type.Array(RuleChangeSchema, { maxItems: 0 }),
    },
    { additionalProperties: false },
  ),
]);
export type SynthesisResult = Static<typeof SynthesisResultSchema>;

export const ExecutionFailureSchema = Type.Object(
  {
    evidence: Type.Array(EvidenceRefSchema),
    failure_class: Type.Union([
      Type.Literal("infrastructure"),
      Type.Literal("agent_process"),
      Type.Literal("configuration"),
      Type.Literal("auth"),
      Type.Literal("policy"),
      Type.Literal("task"),
    ]),
    handoff: HandoffSchema,
    role: Type.Union([
      Type.Literal("plan_review"),
      Type.Literal("implementation"),
      Type.Literal("integrative_review"),
      Type.Literal("specialist_review"),
      Type.Literal("adjudication"),
      Type.Literal("synthesis"),
    ]),
    status: Type.Union([Type.Literal("failed"), Type.Literal("budget_exhausted")]),
    summary: NonEmptyString,
  },
  { additionalProperties: false },
);
export type ExecutionFailure = Static<typeof ExecutionFailureSchema>;

export type AdjudicationValidation =
  | { ok: true }
  | { ok: false; reason: "adjudication.invalid" | "adjudication.resolution_set_mismatch" };

export function validateAdjudicationResult(value: unknown): AdjudicationValidation {
  if (!Value.Check(AdjudicationResultSchema, value)) {
    return { ok: false, reason: "adjudication.invalid" };
  }
  if (value.decision === "needs_human") return { ok: true };

  const conflictIds = new Set(value.conflict_ids);
  const resolutionIds = value.resolutions.map((resolution) => resolution.conflict_id);
  if (
    resolutionIds.length !== conflictIds.size ||
    new Set(resolutionIds).size !== conflictIds.size ||
    resolutionIds.some((id) => !conflictIds.has(id))
  ) {
    return { ok: false, reason: "adjudication.resolution_set_mismatch" };
  }
  return { ok: true };
}
