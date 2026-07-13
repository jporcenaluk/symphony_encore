import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface QueueSynthesisSystemJobInput {
  acceptanceCriteria: readonly string[];
  configSnapshotId: string;
  createdAt: string;
  goal: string;
  id: string;
  repository: string;
  workspacePath: string;
}

export async function queueSynthesisSystemJob(
  database: Kysely<DatabaseSchema>,
  input: QueueSynthesisSystemJobInput,
): Promise<{ created: boolean; id: string }> {
  return database.transaction().execute(async (transaction) => {
    const inserted = await sql`
      insert into system_jobs (
        id, kind, parent_work_ref_kind, parent_work_ref_id, repository,
        workspace_path, goal, acceptance_criteria_json, config_snapshot_id,
        status, input_tokens, output_tokens, cost_usd, created_at, started_at,
        ended_at, final_result_id
      )
      select
        ${input.id}, 'synthesis', null, null, ${input.repository}, ${input.workspacePath},
        ${input.goal}, ${JSON.stringify(input.acceptanceCriteria)}, ${input.configSnapshotId},
        'queued', 0, 0, null, ${input.createdAt}, null, null, null
      where not exists (
        select 1 from system_jobs
        where kind = 'synthesis' and status not in ('done', 'failed')
      )
    `.execute(transaction);
    if (inserted.numAffectedRows === 1n) return { created: true, id: input.id };

    const active = await sql<{ id: string }>`
      select id from system_jobs
      where kind = 'synthesis' and status not in ('done', 'failed')
      order by created_at, id
      limit 1
    `.execute(transaction);
    const activeId = active.rows[0]?.id;
    if (!activeId) throw new Error("system_job.active_synthesis_missing");
    return { created: false, id: activeId };
  });
}
