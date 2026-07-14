import type { SynthesisResult } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { finishAttemptInTransaction } from "./finish-attempt.js";

export interface FinishSynthesisAttemptInput {
  attemptId: string;
  costUsd: number | null;
  endedAt: string;
  questionId: string | null;
  reservationId: string;
  result: SynthesisResult;
  settledLedgers: readonly { actualAmount: number; id: string }[];
  stageTransitionId: string;
  terminalResultId: string;
  usage: { inputTokens: number; outputTokens: number };
  workRef: { id: string; kind: "system_job" };
}

export async function finishSynthesisAttempt(
  database: Kysely<DatabaseSchema>,
  input: FinishSynthesisAttemptInput,
): Promise<void> {
  validateInput(input);
  await database.transaction().execute(async (transaction) => {
    if (input.result.decision === "needs_input") {
      const questionId = input.questionId as string;
      await sql`
        insert into operator_questions (
          id, work_ref_kind, work_ref_id, attempt_id, text, options_json,
          default_answer, comment_marker, asked_at
        ) values (
          ${questionId}, 'system_job', ${input.workRef.id}, ${input.attemptId},
          ${input.result.question.text}, ${JSON.stringify(input.result.question.options)},
          ${input.result.question.default}, ${`<!-- symphony-question:${questionId} -->`},
          ${input.endedAt}
        )
      `.execute(transaction);
    }
    const targetStage =
      input.result.decision === "no_change"
        ? ("done" as const)
        : input.result.decision === "needs_input"
          ? ("human" as const)
          : ("review" as const);
    const nextClaim =
      input.result.decision === "no_change"
        ? ({ mode: "Released", reason: "synthesis_no_change" } as const)
        : input.result.decision === "needs_input"
          ? ({
              approvalRequestId: null,
              blockerPredicate: null,
              mode: "AwaitingHuman" as const,
              questionId: input.questionId,
              reason: "needs_input",
            } as const)
          : ({ mode: "Ready", reason: "synthesis_verification_required" } as const);
    await finishAttemptInTransaction(transaction, {
      attemptId: input.attemptId,
      costUsd: input.costUsd,
      endedAt: input.endedAt,
      failureClass: null,
      nextClaim,
      parkedOriginStage: "running",
      reservationId: input.reservationId,
      settledLedgers: input.settledLedgers,
      systemJobStageTransition: {
        attemptId: input.attemptId,
        confirmedExternalRevision: null,
        enteredAt: input.endedAt,
        expectedFromStage: "running",
        id: input.stageTransitionId,
        reason: `synthesis.${input.result.decision}`,
        timestampSource: "observed_estimate",
        toStage: targetStage,
        workRef: input.workRef,
      },
      terminalResult: {
        id: input.terminalResultId,
        kind: "synthesis_result",
        payload: input.result,
        role: "synthesis",
      },
      usage: input.usage,
      workRef: input.workRef,
    });
  });
}

function validateInput(input: FinishSynthesisAttemptInput): void {
  if (
    !input.attemptId ||
    !input.reservationId ||
    !input.stageTransitionId ||
    !input.terminalResultId ||
    !input.workRef.id ||
    !Number.isFinite(Date.parse(input.endedAt)) ||
    (input.result.decision === "needs_input") !== Boolean(input.questionId)
  ) {
    throw new Error("synthesis.finish_input_invalid");
  }
}
