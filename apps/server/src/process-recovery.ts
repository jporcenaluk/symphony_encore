import type { terminateLinuxProcessGroup } from "@symphony/adapters";
import { listInterruptedAttempts, type OpenedDatabase } from "@symphony/persistence";

type RecoveredOwnership =
  | { kind: "no_session"; verifiedAt: string }
  | {
      kind: "terminated";
      processGroupId: number;
      processId: number;
      verifiedAt: string;
    };

export interface ReconcileInterruptedProcessesInput {
  closeInterruptedAttempt(input: {
    attemptId: string;
    ownership: RecoveredOwnership;
  }): Promise<void>;
  database: OpenedDatabase["database"];
  killWaitMs: number;
  terminateProcessGroup: typeof terminateLinuxProcessGroup;
  terminateWaitMs: number;
  verifiedAt: string;
}

export async function reconcileInterruptedProcesses(
  input: ReconcileInterruptedProcessesInput,
): Promise<void> {
  const attempts = await listInterruptedAttempts(input.database);
  for (const attempt of attempts) {
    if (attempt.processId === null && attempt.processGroupId === null) {
      await input.closeInterruptedAttempt({
        attemptId: attempt.attemptId,
        ownership: { kind: "no_session", verifiedAt: input.verifiedAt },
      });
      continue;
    }
    if (attempt.processId === null || attempt.processGroupId === null) {
      throw new Error(`recovery.process_identity_incomplete:${attempt.attemptId}`);
    }
    await input.terminateProcessGroup({
      killWaitMs: input.killWaitMs,
      processGroupId: attempt.processGroupId,
      processId: attempt.processId,
      terminateWaitMs: input.terminateWaitMs,
    });
    await input.closeInterruptedAttempt({
      attemptId: attempt.attemptId,
      ownership: {
        kind: "terminated",
        processGroupId: attempt.processGroupId,
        processId: attempt.processId,
        verifiedAt: input.verifiedAt,
      },
    });
  }
}
