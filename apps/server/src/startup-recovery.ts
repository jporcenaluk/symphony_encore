import { reconcileWorkspaceOwnership } from "@symphony/adapters";
import {
  completeServiceRecovery,
  listClaimedWorkspaceOwnership,
  type OpenedDatabase,
} from "@symphony/persistence";

export interface StartupRecoveryInput {
  completedAt: string;
  database: OpenedDatabase["database"];
  processOwnershipReconciled: boolean;
  quarantineId: string;
  serviceRunId: string;
  workspaceRoot: string;
}

export async function recoverStartupState(input: StartupRecoveryInput) {
  if (!input.processOwnershipReconciled) {
    throw new Error("recovery.process_ownership_unverified");
  }

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
