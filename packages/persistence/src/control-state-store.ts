import type { ActiveServiceState, ControlState } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface ActiveServiceRunRow {
  id: string;
  service_version: string;
  started_at: string;
  status: string;
}

async function loadActiveServiceRun(
  database: Kysely<DatabaseSchema>,
): Promise<ActiveServiceRunRow & { status: ActiveServiceState }> {
  const result = await sql<ActiveServiceRunRow>`
    select id, service_version, started_at, status
    from service_runs
    where ended_at is null and status in ('starting', 'recovering', 'ready', 'failed')
    order by started_at desc, id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  if (row === undefined) throw new Error("control_state.active_service_run_missing");
  if (!isActiveServiceState(row.status)) throw new Error("control_state.invalid_service_state");
  return { ...row, status: row.status };
}

export async function readServiceStatus(
  database: Kysely<DatabaseSchema>,
): Promise<{ id: string; state: ActiveServiceState }> {
  const serviceRun = await loadActiveServiceRun(database);
  return { id: serviceRun.id, state: serviceRun.status };
}

export async function readControlState(database: Kysely<DatabaseSchema>): Promise<ControlState> {
  const serviceRun = await loadActiveServiceRun(database);
  const enabled = serviceRun.status === "ready";
  return {
    dispatch_enabled: enabled,
    mutations_enabled: enabled,
    service_run: {
      id: serviceRun.id,
      service_version: serviceRun.service_version,
      started_at: serviceRun.started_at,
      status: serviceRun.status,
    },
    version: `service-run:${serviceRun.id}:${serviceRun.status}`,
  };
}

function isActiveServiceState(value: string): value is ActiveServiceState {
  return value === "starting" || value === "recovering" || value === "ready" || value === "failed";
}
