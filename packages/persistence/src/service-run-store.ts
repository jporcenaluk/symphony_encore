import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface BeginServiceRunInput {
  hostId: string;
  id: string;
  serviceVersion: string;
  startReason: string;
  startedAt: string;
  startupConfigSnapshotId: string;
}

export async function beginServiceRun(
  database: Kysely<DatabaseSchema>,
  input: BeginServiceRunInput,
): Promise<void> {
  await sql`
    insert into service_runs (
      id, service_version, host_id, started_at, ended_at, status,
      startup_config_snapshot_id, start_reason, end_reason
    ) values (
      ${input.id}, ${input.serviceVersion}, ${input.hostId}, ${input.startedAt},
      null, 'recovering', ${input.startupConfigSnapshotId}, ${input.startReason}, null
    )
  `.execute(database);
}

export interface CompleteServiceRecoveryInput {
  completedAt: string;
  ownershipReconciled: boolean;
  serviceRunId: string;
}

export async function completeServiceRecovery(
  database: Kysely<DatabaseSchema>,
  input: CompleteServiceRecoveryInput,
): Promise<void> {
  if (!input.ownershipReconciled) {
    throw new Error("recovery.process_ownership_unverified");
  }
  await database.transaction().execute(async (transaction) => {
    const current = await sql<{ status: string }>`
      select status from service_runs where id = ${input.serviceRunId}
    `.execute(transaction);
    if (current.rows[0]?.status !== "recovering") {
      throw new Error(`recovery.run_not_recovering:${input.serviceRunId}`);
    }
    await sql`
      update service_runs
      set ended_at = ${input.completedAt}, status = 'interrupted',
          end_reason = 'restart_reconciled'
      where id != ${input.serviceRunId}
        and ended_at is null
        and status in ('starting', 'recovering', 'ready')
    `.execute(transaction);
    const ready = await sql`
      update service_runs
      set status = 'ready'
      where id = ${input.serviceRunId} and status = 'recovering' and ended_at is null
    `.execute(transaction);
    if (ready.numAffectedRows !== 1n) {
      throw new Error(`recovery.run_not_recovering:${input.serviceRunId}`);
    }
  });
}
