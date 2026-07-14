import { terminateLinuxProcessGroup } from "@symphony/adapters";
import type { SideEffectIntent, SideEffectReceipt } from "@symphony/contracts";
import {
  listInterruptedAttempts,
  loadUnreconciledIntents,
  markLiveSessionOwnershipVerified,
  type OpenedDatabase,
  recordSideEffectReceipt,
  recordStartupFailure,
} from "@symphony/persistence";

export interface CorruptStoreRecoveryInput {
  database: OpenedDatabase["database"];
  failureId: string;
  lookupReceiptByIdempotencyKey?: (intent: SideEffectIntent) => Promise<SideEffectReceipt | null>;
  occurredAt: string;
  populatedTables: readonly string[];
  terminateProcessGroup?: typeof terminateLinuxProcessGroup;
}

export interface CorruptStoreRecoveryResult {
  attempts_inspected: number;
  owned_processes_terminated: number;
  receipts_recorded: number;
  recovery_complete: boolean;
  recovery_error?: string;
  unreconciled_intents_inspected: number;
}

export async function recoverCorruptOperatorStore(
  input: CorruptStoreRecoveryInput,
): Promise<CorruptStoreRecoveryResult> {
  const terminate = input.terminateProcessGroup ?? terminateLinuxProcessGroup;
  const attempts = await listInterruptedAttempts(input.database);
  let ownedProcessesTerminated = 0;
  let recoveryError: string | undefined;

  for (const attempt of attempts) {
    if (attempt.processId === null && attempt.processGroupId === null) continue;
    if (attempt.processId === null || attempt.processGroupId === null) {
      recoveryError ??= `process_identity_incomplete:${attempt.attemptId}`;
      continue;
    }
    try {
      await terminate({
        killWaitMs: 5_000,
        processGroupId: attempt.processGroupId,
        processId: attempt.processId,
        terminateWaitMs: 1_000,
      });
      await markLiveSessionOwnershipVerified(input.database, {
        attemptId: attempt.attemptId,
        processGroupId: attempt.processGroupId,
        processId: attempt.processId,
        verifiedAt: input.occurredAt,
      });
      ownedProcessesTerminated += 1;
    } catch {
      recoveryError ??= `process_termination_unverified:${attempt.attemptId}`;
    }
  }

  const intents = await loadUnreconciledIntents(input.database);
  let receiptsRecorded = 0;
  for (const intent of intents) {
    if (!input.lookupReceiptByIdempotencyKey) {
      recoveryError ??= `provider_reconciliation_unavailable:${intent.id}`;
      continue;
    }
    try {
      const receipt = await input.lookupReceiptByIdempotencyKey(intent);
      if (receipt === null) continue;
      if (receipt.intent_id !== intent.id) {
        throw new Error("recovery.receipt_intent_mismatch");
      }
      await recordSideEffectReceipt(input.database, receipt);
      receiptsRecorded += 1;
    } catch {
      recoveryError ??= `provider_reconciliation_failed:${intent.id}`;
    }
  }

  const result: CorruptStoreRecoveryResult = {
    attempts_inspected: attempts.length,
    owned_processes_terminated: ownedProcessesTerminated,
    receipts_recorded: receiptsRecorded,
    recovery_complete: recoveryError === undefined,
    ...(recoveryError ? { recovery_error: recoveryError } : {}),
    unreconciled_intents_inspected: intents.length,
  };
  await recordStartupFailure(input.database, {
    details: {
      populated_tables: [...input.populatedTables],
      ...result,
    },
    id: input.failureId,
    occurredAt: input.occurredAt,
    reasonCode: "operator_store_missing_nonpristine",
  });
  return result;
}
