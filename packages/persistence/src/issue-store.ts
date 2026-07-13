import type { Issue } from "@symphony/contracts";
import { validateIssueNormalization } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

interface IssueRow {
  acceptance_criteria_json: string;
  assignee_id: string | null;
  blocked_by_json: string;
  created_at: string;
  description: string;
  id: string;
  identifier: string;
  labels_json: string;
  priority: number | null;
  provider_revision: string;
  repo_name: string;
  repo_owner: string;
  state: Issue["state"];
  title: string;
  updated_at: string;
  url: string;
}

export interface StoredIssue {
  issue: Issue;
  providerRevision: string;
}

export async function upsertIssue(
  database: Kysely<DatabaseSchema>,
  issue: Issue,
  providerRevision: string,
): Promise<void> {
  const validation = validateIssueNormalization(issue);
  if (!validation.ok) throw new Error(validation.reason);
  await sql`
    insert into issues (
      id, identifier, title, description, acceptance_criteria_json, state,
      labels_json, priority, blocked_by_json, assignee_id, repo_owner,
      repo_name, url, provider_revision, created_at, updated_at
    ) values (
      ${issue.id}, ${issue.identifier}, ${issue.title}, ${issue.description},
      ${JSON.stringify(issue.acceptance_criteria)}, ${issue.state},
      ${JSON.stringify(issue.labels)}, ${issue.priority},
      ${JSON.stringify(issue.blocked_by)}, ${issue.assignee_id}, ${issue.repo_owner},
      ${issue.repo_name}, ${issue.url}, ${providerRevision}, ${issue.created_at},
      ${issue.updated_at}
    )
    on conflict (id) do update set
      title = excluded.title,
      description = excluded.description,
      acceptance_criteria_json = excluded.acceptance_criteria_json,
      state = excluded.state,
      labels_json = excluded.labels_json,
      priority = excluded.priority,
      blocked_by_json = excluded.blocked_by_json,
      assignee_id = excluded.assignee_id,
      url = excluded.url,
      provider_revision = excluded.provider_revision,
      updated_at = excluded.updated_at
  `.execute(database);
}

export async function loadIssue(
  database: Kysely<DatabaseSchema>,
  id: string,
): Promise<StoredIssue | undefined> {
  const result = await sql<IssueRow>`select * from issues where id = ${id}`.execute(database);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const issue: Issue = {
    acceptance_criteria: JSON.parse(row.acceptance_criteria_json) as string[],
    assignee_id: row.assignee_id,
    blocked_by: JSON.parse(row.blocked_by_json) as Array<{ id: string; state: string }>,
    created_at: row.created_at,
    description: row.description,
    id: row.id,
    identifier: row.identifier,
    labels: JSON.parse(row.labels_json) as string[],
    priority: row.priority,
    repo_name: row.repo_name,
    repo_owner: row.repo_owner,
    state: row.state,
    title: row.title,
    updated_at: row.updated_at,
    url: row.url,
  };
  const validation = validateIssueNormalization(issue);
  if (!validation.ok) throw new Error(`Stored issue is invalid: ${validation.reason}`);
  return { issue, providerRevision: row.provider_revision };
}
