import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { countRunningClaims, isWorkClaimed, listRunningIssueAttempts } from "./scheduler-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-scheduler-store-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into issues (
        id, identifier, title, description, acceptance_criteria_json, state,
        labels_json, priority, blocked_by_json, assignee_id, repo_owner,
        repo_name, url, provider_revision, created_at, updated_at
      ) values (
        'issue-1', 'ORG-1', 'Issue', '', '[]', 'In Progress', '[]', null, '[]', null,
        'owner', 'repo', 'https://example.test/issues/1', 'revision-1',
        '2026-07-13T09:00:00Z', '2026-07-13T10:00:00Z'
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/work/issue-1',
        'config-1', 'standard', 'model-1', 'medium', null, '[]', 'standard',
        '2026-07-13T10:00:00Z', null, 'running', null, null, 0, 0, 0, null
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Running', '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', '2026-07-13T10:02:00Z', 'Todo', 'dispatch'
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into live_sessions (
        attempt_id, session_id, thread_id, turn_id, process_id, process_group_id,
        adapter_version, protocol_schema_hash, last_event, last_event_at,
        turn_count, last_input_tokens, last_output_tokens, last_total_tokens
      ) values (
        'attempt-1', 'session-1', 'thread-1', 'turn-1', 1001, 1000,
        'codex-1', 'schema-1', 'turn_started', '2026-07-13T10:00:30Z', 1, 0, 0, 0
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into stage_transitions (
        id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, attempt_id,
        confirmed_external_revision, entered_at, timestamp_source
      ) values (
        'stage-1', 'issue', 'issue-1', 'Todo', 'In Progress', 'dispatch', 'attempt-1',
        'revision-1', '2026-07-13T10:00:01Z', 'receipt'
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("scheduler persistence read model", () => {
  it("loads the exact running issue, lease, session, and current-stage identity", async () => {
    await expect(listRunningIssueAttempts(opened.database)).resolves.toEqual([
      {
        attemptId: "attempt-1",
        attemptLane: "In Progress",
        expectedExpiresAt: "2026-07-13T10:02:00Z",
        holder: "run-1",
        issueId: "issue-1",
        lastEventAt: "2026-07-13T10:00:30Z",
        processGroupId: 1000,
        processId: 1001,
        workspacePath: "/work/issue-1",
      },
    ]);
  });

  it("counts running leases as slots and answers claim conflicts by work ref", async () => {
    await expect(countRunningClaims(opened.database)).resolves.toBe(1);
    await expect(isWorkClaimed(opened.database, { id: "issue-1", kind: "issue" })).resolves.toBe(
      true,
    );
    await expect(isWorkClaimed(opened.database, { id: "issue-2", kind: "issue" })).resolves.toBe(
      false,
    );
  });

  it("fails closed when a running lease lacks complete process identity", async () => {
    opened.sqlite.prepare("delete from live_sessions where attempt_id = 'attempt-1'").run();
    await expect(listRunningIssueAttempts(opened.database)).rejects.toThrow(
      "scheduler.running_issue_identity_incomplete",
    );
  });
});
