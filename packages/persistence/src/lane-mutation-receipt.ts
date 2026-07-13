import type { SideEffectReceipt } from "@symphony/contracts";
import type { Kysely } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { recordSideEffectReceiptInTransaction } from "./side-effect-store.js";
import { type StageTransitionInput, transitionStageInTransaction } from "./stage-transition.js";

export async function recordLaneMutationReceipt(
  database: Kysely<DatabaseSchema>,
  input: { receipt: SideEffectReceipt; transition: StageTransitionInput },
): Promise<void> {
  if (
    input.transition.timestampSource !== "receipt" ||
    input.transition.confirmedExternalRevision !== input.receipt.result_revision ||
    input.transition.enteredAt !== input.receipt.applied_at
  ) {
    throw new Error("side_effect.receipt_transition_mismatch");
  }
  await database.transaction().execute(async (transaction) => {
    await recordSideEffectReceiptInTransaction(transaction, input.receipt);
    await transitionStageInTransaction(transaction, input.transition);
  });
}
