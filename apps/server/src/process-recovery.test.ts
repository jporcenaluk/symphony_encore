import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, type OpenedDatabase, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcileInterruptedProcesses } from "./process-recovery.js";

const databases: OpenedDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("interrupted process recovery", () => {
  it("closes sessionless attempts and terminates recorded process groups before closure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-process-recovery-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    databases.push(opened);
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    const insertAttempt = opened.sqlite.prepare(`
      insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status
      ) values (?, 'issue', ?, 'implementation', 1, ?, 'config-1', 'standard',
        'model', 'medium', '[]', 'standard', ?, 'running')
    `);
    insertAttempt.run("attempt-1", "issue-1", "/work/issue-1", "2026-07-13T10:00:00Z");
    insertAttempt.run("attempt-2", "issue-2", "/work/issue-2", "2026-07-13T10:00:01Z");
    opened.sqlite
      .prepare(`
        insert into live_sessions (
          attempt_id, session_id, thread_id, process_id, process_group_id,
          adapter_version, protocol_schema_hash, last_event, last_event_at
        ) values ('attempt-2', 'session-2', 'thread-2', 4321, 4320,
          'adapter-1', 'schema-1', 'turn_started', '2026-07-13T10:00:02Z')
      `)
      .run();
    const order: string[] = [];
    const terminateProcessGroup = vi.fn(async () => {
      order.push("terminate");
      return { outcome: "killed" as const };
    });
    const closeInterruptedAttempt = vi.fn(async (input: { attemptId: string }) => {
      order.push(`close:${input.attemptId}`);
    });

    await reconcileInterruptedProcesses({
      closeInterruptedAttempt,
      database: opened.database,
      killWaitMs: 1_000,
      terminateProcessGroup,
      terminateWaitMs: 100,
      verifiedAt: "2026-07-13T10:01:00Z",
    });

    expect(terminateProcessGroup).toHaveBeenCalledWith({
      killWaitMs: 1_000,
      processGroupId: 4320,
      processId: 4321,
      terminateWaitMs: 100,
    });
    expect(closeInterruptedAttempt.mock.calls).toEqual([
      [
        {
          attemptId: "attempt-1",
          ownership: { kind: "no_session", verifiedAt: "2026-07-13T10:01:00Z" },
        },
      ],
      [
        {
          attemptId: "attempt-2",
          ownership: {
            kind: "terminated",
            processGroupId: 4320,
            processId: 4321,
            verifiedAt: "2026-07-13T10:01:00Z",
          },
        },
      ],
    ]);
    expect(order).toEqual(["close:attempt-1", "terminate", "close:attempt-2"]);
  });
});
