import { reconcileWorkspaceOwnership, terminateLinuxProcessGroup } from "@symphony/adapters";
import type { Handoff } from "@symphony/contracts";
import {
  completeServiceRecovery,
  listClaimedWorkspaceOwnership,
  type OpenedDatabase,
  recoverInterruptedAttempt,
} from "@symphony/persistence";

import { reconcileInterruptedProcesses } from "./process-recovery.js";

export interface StartupRecoveryInput {
  completedAt: string;
  database: OpenedDatabase["database"];
  quarantineId: string;
  reconcileProcessOwnership(): Promise<void>;
  serviceRunId: string;
  workspaceRoot: string;
}

export async function recoverStartupState(input: StartupRecoveryInput) {
  await input.reconcileProcessOwnership();

  const owned = await listClaimedWorkspaceOwnership(input.database);
  const workspaceReconciliation = await reconcileWorkspaceOwnership({
    owned,
    quarantineId: input.quarantineId,
    workspaceRoot: input.workspaceRoot,
  });
  await completeServiceRecovery(input.database, {
    completedAt: input.completedAt,
    ownershipReconciled: true,
    serviceRunId: input.serviceRunId,
  });
  return workspaceReconciliation;
}

export interface LinuxStartupRecoveryInput {
  completedAt: string;
  database: OpenedDatabase["database"];
  loadLatestHandoff(attemptId: string): Promise<Handoff>;
  quarantineId: string;
  serviceRunId: string;
  terminalResultId(attemptId: string): string;
  workspaceRoot: string;
}

export async function recoverLinuxStartupState(input: LinuxStartupRecoveryInput) {
  return recoverStartupState({
    completedAt: input.completedAt,
    database: input.database,
    quarantineId: input.quarantineId,
    async reconcileProcessOwnership() {
      await reconcileInterruptedProcesses({
        async closeInterruptedAttempt(interrupted) {
          await recoverInterruptedAttempt(input.database, {
            attemptId: interrupted.attemptId,
            endedAt: input.completedAt,
            latestHandoff: await input.loadLatestHandoff(interrupted.attemptId),
            ownership: interrupted.ownership,
            terminalResultId: input.terminalResultId(interrupted.attemptId),
          });
        },
        database: input.database,
        killWaitMs: 5_000,
        terminateProcessGroup: terminateLinuxProcessGroup,
        terminateWaitMs: 1_000,
        verifiedAt: input.completedAt,
      });
    },
    serviceRunId: input.serviceRunId,
    workspaceRoot: input.workspaceRoot,
  });
}
