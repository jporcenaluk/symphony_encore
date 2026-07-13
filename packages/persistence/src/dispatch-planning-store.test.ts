import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { listAttemptUsageHistory, nextAttemptNumber } from "./dispatch-planning-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-dispatch-planning-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function insertAttempt(input: {
  costUsd: number | null;
  endedAt: string | null;
  id: string;
  number: number;
  profile?: string;
  role?: string;
  status?: string;
  tokens: number;
  workId?: string;
}): void {
  const status = input.status ?? "closed";
  const terminalResultId = status === "closed" ? `${input.id}:result` : null;
  if (terminalResultId) {
    opened.sqlite
      .prepare("insert into terminal_results values (?, ?, ?, 'fixture', '{}', ?)")
      .run(terminalResultId, input.id, input.role ?? "implementation", input.endedAt);
  }
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status, terminal_result_id, input_tokens, output_tokens,
        total_tokens, cost_usd
      ) values (?, 'issue', ?, ?, ?, '/tmp/work', 'config-1', ?, 'model', 'medium',
                '[]', 'standard', ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.id,
      input.workId ?? "issue-1",
      input.role ?? "implementation",
      input.number,
      input.profile ?? "standard",
      `2026-07-13T10:0${input.number}:00Z`,
      input.endedAt,
      status,
      terminalResultId,
      input.tokens,
      input.tokens,
      input.costUsd,
    );
}

describe("dispatch planning persistence", () => {
  it("allocates the next number per work ref across closed and open attempts", async () => {
    expect(await nextAttemptNumber(opened.database, { id: "issue-1", kind: "issue" })).toBe(1);
    insertAttempt({
      costUsd: null,
      endedAt: "2026-07-13T10:01:30Z",
      id: "attempt-1",
      number: 1,
      tokens: 10,
    });
    insertAttempt({
      costUsd: null,
      endedAt: null,
      id: "attempt-2",
      number: 2,
      status: "created",
      tokens: 0,
    });
    insertAttempt({
      costUsd: null,
      endedAt: "2026-07-13T10:01:30Z",
      id: "attempt-other",
      number: 1,
      tokens: 10,
      workId: "issue-2",
    });

    expect(await nextAttemptNumber(opened.database, { id: "issue-1", kind: "issue" })).toBe(3);
    expect(await nextAttemptNumber(opened.database, { id: "issue-2", kind: "issue" })).toBe(2);
  });

  it("returns a bounded chronological same-role/profile closed history", async () => {
    insertAttempt({
      costUsd: 0.1,
      endedAt: "2026-07-13T10:01:30Z",
      id: "a1",
      number: 1,
      tokens: 100,
    });
    insertAttempt({
      costUsd: null,
      endedAt: "2026-07-13T10:02:30Z",
      id: "a2",
      number: 2,
      tokens: 200,
    });
    insertAttempt({
      costUsd: 0.3,
      endedAt: "2026-07-13T10:03:30Z",
      id: "a3",
      number: 3,
      tokens: 300,
    });
    insertAttempt({
      costUsd: 9,
      endedAt: "2026-07-13T10:04:30Z",
      id: "other-role",
      number: 4,
      role: "plan_review",
      tokens: 900,
    });
    insertAttempt({
      costUsd: 9,
      endedAt: null,
      id: "open",
      number: 5,
      status: "running",
      tokens: 900,
    });

    await expect(
      listAttemptUsageHistory(opened.database, {
        limit: 2,
        profile: "standard",
        role: "implementation",
      }),
    ).resolves.toEqual([
      { costUsd: null, totalTokens: 200 },
      { costUsd: 0.3, totalTokens: 300 },
    ]);
  });

  it("rejects invalid planning queries", async () => {
    await expect(nextAttemptNumber(opened.database, { id: "", kind: "issue" })).rejects.toThrow(
      "dispatch_planning.work_ref_invalid",
    );
    await expect(
      listAttemptUsageHistory(opened.database, {
        limit: 0,
        profile: "standard",
        role: "implementation",
      }),
    ).rejects.toThrow("dispatch_planning.history_limit_invalid");
  });
});
