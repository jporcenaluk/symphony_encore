import type { SideEffectReceipt } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { recordSideEffectReceiptInTransaction } from "./side-effect-store.js";
import { type StageTransitionInput, transitionStageInTransaction } from "./stage-transition.js";

export async function recordLaneMutationReceipt(
  database: Kysely<DatabaseSchema>,
  input: { receipt: SideEffectReceipt; transition: StageTransitionInput },
): Promise<void> {
  if (
    input.transition.workRef.kind !== "issue" ||
    input.transition.timestampSource !== "receipt" ||
    input.receipt.result_revision === null ||
    input.transition.confirmedExternalRevision !== input.receipt.result_revision ||
    input.transition.enteredAt !== input.receipt.applied_at
  ) {
    throw new Error("side_effect.receipt_transition_mismatch");
  }
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    await transitionStageInTransaction(transaction, input.transition);
    const issue = await sql`
      update issues
      set state = ${input.transition.toStage},
          provider_revision = ${input.receipt.result_revision}
      where id = ${input.transition.workRef.id}
        and state = ${input.transition.expectedFromStage}
    `.execute(transaction);
    if (issue.numAffectedRows !== 1n) {
      throw new Error("side_effect.issue_state_mismatch");
    }
  });
}
