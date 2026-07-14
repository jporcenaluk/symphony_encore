import type { SystemJob } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";
import { openBaselineStageInTransaction } from "./stage-transition.js";

export interface QueueSynthesisSystemJobInput {
  acceptanceCriteria: readonly string[];
  configSnapshotId: string;
  createdAt: string;
  goal: string;
  id: string;
  repository: string;
  serviceRunId: string;
  transitionId: string;
  trigger: "interval" | "operator";
  workspacePath: string;
}

interface SystemJobRow {
  acceptance_criteria_json: string;
  config_snapshot_id: string;
  cost_usd: number | null;
  created_at: string;
  ended_at: string | null;
  final_result_id: string | null;
  goal: string;
  id: string;
  input_tokens: number;
  kind: "repair" | "synthesis";
  output_tokens: number;
  parent_work_ref_id: string | null;
  parent_work_ref_kind: "issue" | "system_job" | null;
  repository: string;
  started_at: string | null;
  status: SystemJob["status"];
  workspace_path: string;
}

export async function loadSystemJob(
  database: Kysely<DatabaseSchema>,
  id: string,
): Promise<SystemJob | null> {
  if (!id) throw new Error("system_job.id_invalid");
  const result = await sql<SystemJobRow>`
    select * from system_jobs where id = ${id}
  `.execute(database);
  const row = result.rows[0];
  if (!row) return null;
  const acceptanceCriteria = parseAcceptanceCriteria(row.acceptance_criteria_json);
  const common = {
    acceptance_criteria: acceptanceCriteria,
    config_snapshot_id: row.config_snapshot_id,
    cost_usd: row.cost_usd,
    created_at: row.created_at,
    ended_at: row.ended_at,
    final_result_id: row.final_result_id,
    goal: row.goal,
    id: row.id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    repository: row.repository,
    started_at: row.started_at,
    status: row.status,
    workspace_path: row.workspace_path,
  };
  if (row.kind === "synthesis") {
    if (row.parent_work_ref_kind !== null || row.parent_work_ref_id !== null) {
      throw new Error("system_job.parent_invalid");
    }
    return { ...common, kind: "synthesis", parent_work_ref: null };
  }
  if (!row.parent_work_ref_kind || !row.parent_work_ref_id) {
    throw new Error("system_job.parent_invalid");
  }
  return {
    ...common,
    kind: "repair",
    parent_work_ref:
      row.parent_work_ref_kind === "issue"
        ? { issue_id: row.parent_work_ref_id }
        : { system_job_id: row.parent_work_ref_id },
  };
}

export async function queueSynthesisSystemJob(
  database: Kysely<DatabaseSchema>,
  input: QueueSynthesisSystemJobInput,
): Promise<{ created: boolean; id: string }> {
  if (
    !input.id ||
    !input.serviceRunId ||
    !input.transitionId ||
    !Number.isFinite(Date.parse(input.createdAt))
  ) {
    throw new Error("system_job.synthesis_queue_input_invalid");
  }
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
    if (inserted.numAffectedRows === 1n) {
      await openBaselineStageInTransaction(transaction, {
        enteredAt: input.createdAt,
        id: input.transitionId,
        reason: `learning.synthesis_${input.trigger}`,
        timestampSource: "observed_estimate",
        toStage: "queued",
        workRef: { id: input.id, kind: "system_job" },
      });
      await sql`
        insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values (
          'system_job', ${input.id}, ${input.serviceRunId}, 'Ready', ${input.createdAt},
          ${input.createdAt}, null, 'queued', 'system_job_dispatch_required'
        )
      `.execute(transaction);
      return { created: true, id: input.id };
    }

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

function parseAcceptanceCriteria(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((criterion) => typeof criterion !== "string" || !criterion)
  ) {
    throw new Error("system_job.acceptance_criteria_invalid");
  }
  return parsed;
}
