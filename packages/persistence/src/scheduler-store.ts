import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface RunningIssueAttemptRecord {
  attemptId: string;
  attemptLane: string;
  expectedExpiresAt: string;
  holder: string;
  issueId: string;
  lastEventAt: string;
  processGroupId: number;
  processId: number;
  workspacePath: string;
}

interface RunningIssueAttemptRow {
  attempt_id: string;
  expires_at: string;
  holder: string;
  last_event_at: string;
  process_group_id: number;
  process_id: number;
  stage: string;
  work_ref_id: string;
  workspace_path: string;
}

export async function countRunningClaims(database: Kysely<DatabaseSchema>): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*) as count from claims where mode = 'Running'
  `.execute(database);
  return result.rows[0]?.count ?? 0;
}

export async function isWorkClaimed(
  database: Kysely<DatabaseSchema>,
  workRef: { id: string; kind: "issue" | "system_job" },
): Promise<boolean> {
  const result = await sql<{ claimed: number }>`
    select exists(
      select 1 from claims
      where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
    ) as claimed
  `.execute(database);
  return result.rows[0]?.claimed === 1;
}

export async function listRunningIssueAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<RunningIssueAttemptRecord[]> {
  return database.transaction().execute(async (transaction) => {
    const expected = await sql<{ count: number }>`
      select count(*) as count from claims
      where mode = 'Running' and work_ref_kind = 'issue'
    `.execute(transaction);
    const rows = await sql<RunningIssueAttemptRow>`
      select attempts.id as attempt_id, attempts.work_ref_id, attempts.workspace_path,
             claims.holder, claims.expires_at, live_sessions.last_event_at,
             live_sessions.process_id, live_sessions.process_group_id,
             stage_transitions.to_stage as stage
      from claims
      join attempts
        on attempts.work_ref_kind = claims.work_ref_kind
        and attempts.work_ref_id = claims.work_ref_id
        and attempts.status = 'running'
      join live_sessions on live_sessions.attempt_id = attempts.id
      join stage_transitions
        on stage_transitions.work_ref_kind = claims.work_ref_kind
        and stage_transitions.work_ref_id = claims.work_ref_id
        and stage_transitions.exited_at is null
      where claims.mode = 'Running' and claims.work_ref_kind = 'issue'
      order by attempts.started_at, attempts.id
    `.execute(transaction);
    if (rows.rows.length !== (expected.rows[0]?.count ?? 0)) {
      throw new Error("scheduler.running_issue_identity_incomplete");
    }
    return rows.rows.map((row) => ({
      attemptId: row.attempt_id,
      attemptLane: row.stage,
      expectedExpiresAt: row.expires_at,
      holder: row.holder,
      issueId: row.work_ref_id,
      lastEventAt: row.last_event_at,
      processGroupId: row.process_group_id,
      processId: row.process_id,
      workspacePath: row.workspace_path,
    }));
  });
}
