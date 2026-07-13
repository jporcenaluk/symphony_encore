import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { loadSystemJob, queueSynthesisSystemJob } from "./system-job-store.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function database(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-system-job-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  databases.push(opened);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  return opened;
}

function request(id: string) {
  return {
    acceptanceCriteria: ["Every proposed rule cites durable lessons"],
    configSnapshotId: "config-1",
    createdAt: "2026-07-13T11:00:00Z",
    goal: "Synthesize recent lessons into a bounded workflow proposal",
    id,
    repository: "example/repo",
    workspacePath: `/tmp/work/_system/synthesis-${id}`,
  };
}

describe("synthesis SystemJob queue", () => {
  it("loads a typed repair job with its parent work reference", async () => {
    const opened = await database();
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, parent_work_ref_kind, parent_work_ref_id, repository, workspace_path,
          goal, acceptance_criteria_json, config_snapshot_id, status, input_tokens,
          output_tokens, cost_usd, created_at, started_at, ended_at, final_result_id
        ) values ('repair-1', 'repair', 'issue', 'issue-1', 'example/repo',
          '/tmp/work/_system/repair-repair-1', 'Repair failed merge', '["Restore checks"]',
          'config-1', 'queued', 0, 0, null, 't0', null, null, null)`,
      )
      .run();

    await expect(loadSystemJob(opened.database, "repair-1")).resolves.toMatchObject({
      acceptance_criteria: ["Restore checks"],
      id: "repair-1",
      kind: "repair",
      parent_work_ref: { issue_id: "issue-1" },
      status: "queued",
    });
  });

  it("atomically preserves one active synthesis job", async () => {
    const opened = await database();

    await expect(queueSynthesisSystemJob(opened.database, request("job-1"))).resolves.toEqual({
      created: true,
      id: "job-1",
    });
    await expect(queueSynthesisSystemJob(opened.database, request("job-2"))).resolves.toEqual({
      created: false,
      id: "job-1",
    });
    expect(opened.sqlite.prepare("select count(*) as count from system_jobs").get()).toEqual({
      count: 1,
    });
  });

  it("permits a new synthesis only after the prior job is terminal", async () => {
    const opened = await database();
    await queueSynthesisSystemJob(opened.database, request("job-1"));
    opened.sqlite.prepare("update system_jobs set status = 'done', ended_at = 't1'").run();

    await expect(queueSynthesisSystemJob(opened.database, request("job-2"))).resolves.toEqual({
      created: true,
      id: "job-2",
    });
  });

  it("enforces the one-active-job invariant below the repository helper", async () => {
    const opened = await database();
    await queueSynthesisSystemJob(opened.database, request("job-1"));

    expect(() =>
      opened.sqlite
        .prepare(`
          insert into system_jobs (
            id, kind, repository, workspace_path, goal, acceptance_criteria_json,
            config_snapshot_id, status, created_at
          ) values ('job-2', 'synthesis', 'example/repo', '/tmp/job-2', 'duplicate', '[]',
            'config-1', 'queued', 't1')
        `)
        .run(),
    ).toThrow(/UNIQUE/u);
  });
});
