import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { listClaimedWorkspaceOwnership } from "./workspace-ownership.js";

const openedDatabases: OpenedDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const opened of openedDatabases.splice(0)) await opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function temporaryDatabase(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workspace-owner-"));
  temporaryDirectories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  openedDatabases.push(opened);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  return opened;
}

function insertAttempt(
  opened: OpenedDatabase,
  input: { attemptNumber?: number; id: string; workId: string; workspacePath: string },
): void {
  opened.sqlite
    .prepare(`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status
      ) values (?, 'issue', ?, 'implementation', ?, ?, 'config-1', 'standard',
        'model', 'medium', '[]', 'standard', '2026-07-13T10:00:00Z', 'created')
    `)
    .run(input.id, input.workId, input.attemptNumber ?? 1, input.workspacePath);
}

function insertClaim(opened: OpenedDatabase, workId: string): void {
  opened.sqlite
    .prepare(`
      insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values ('issue', ?, 'service-1', 'Running', '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', '2026-07-13T10:02:00Z', 'Todo', 'dispatch')
    `)
    .run(workId);
}

function insertCheckout(opened: OpenedDatabase, workId: string, workspacePath: string): void {
  opened.sqlite
    .prepare(`
      insert into workspace_checkouts (
        work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
        checkout_method, local_branch, created_at
      ) values (
        'issue', ?, ?, 'owner/repo', '0123456789abcdef0123456789abcdef01234567',
        'trusted_repository_adapter', 'symphony/test', '2026-07-13T10:00:01Z'
      )
    `)
    .run(workId, workspacePath);
}

describe("claimed workspace ownership", () => {
  it("projects one stable workspace for every durable claim", async () => {
    const opened = await temporaryDatabase();
    insertAttempt(opened, { id: "attempt-2", workId: "issue-2", workspacePath: "/work/issue-2" });
    insertClaim(opened, "issue-2");
    insertCheckout(opened, "issue-2", "/work/issue-2");
    insertAttempt(opened, { id: "attempt-1", workId: "issue-1", workspacePath: "/work/issue-1" });
    insertClaim(opened, "issue-1");
    insertCheckout(opened, "issue-1", "/work/issue-1");

    await expect(listClaimedWorkspaceOwnership(opened.database)).resolves.toEqual([
      { workRef: "issue:issue-1", workspacePath: "/work/issue-1" },
      { workRef: "issue:issue-2", workspacePath: "/work/issue-2" },
    ]);
  });

  it("fails closed when one work ref changed workspace across attempts", async () => {
    const opened = await temporaryDatabase();
    insertAttempt(opened, { id: "attempt-1", workId: "issue-1", workspacePath: "/work/issue-1" });
    insertAttempt(opened, {
      attemptNumber: 2,
      id: "attempt-2",
      workId: "issue-1",
      workspacePath: "/work/other",
    });
    insertClaim(opened, "issue-1");
    insertCheckout(opened, "issue-1", "/work/issue-1");

    await expect(listClaimedWorkspaceOwnership(opened.database)).rejects.toThrow(
      "workspace.assignment_changed",
    );
  });

  it("does not claim filesystem ownership before checkout provenance is committed", async () => {
    const opened = await temporaryDatabase();
    insertAttempt(opened, { id: "attempt-1", workId: "issue-1", workspacePath: "/work/issue-1" });
    insertClaim(opened, "issue-1");

    await expect(listClaimedWorkspaceOwnership(opened.database)).resolves.toEqual([]);
  });
});
