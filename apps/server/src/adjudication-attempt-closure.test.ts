import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Issue } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeAdjudicationAttempt } from "./adjudication-attempt-closure.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});

const issue: Issue = {
  acceptance_criteria: ["Resolve contrary review findings"],
  assignee_id: null,
  blocked_by: [],
  created_at: "t0",
  description: "Adjudicate immutable review evidence.",
  id: "issue-1",
  identifier: "ORG-23",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Adjudicate review conflict",
  updated_at: "t1",
  url: "https://example.test/issues/23",
};

describe("adjudication closure", () => {
  it("closes a wrong-SHA terminal result as result_invalid without a Review Record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-adjudication-closure-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    seed(opened.sqlite);
    const safety = new PersistenceSafetyController(vi.fn(async () => undefined));

    await closeAdjudicationAttempt({
      attemptId: "adjudication-1",
      consumption: {
        kind: "terminal_result",
        result: {
          conflict_ids: ["conflict:finding-1+finding-2"],
          decision: "resolve",
          evidence: [{ kind: "file", path: "src/worker.ts" }],
          resolutions: [
            {
              conflict_id: "conflict:finding-1+finding-2",
              evidence: [{ kind: "file", path: "src/worker.ts" }],
              rationale: "The first finding matches the implementation evidence.",
              rejected_finding_ids: ["finding-2"],
              upheld_finding_ids: ["finding-1"],
            },
          ],
          target_sha: "fffffff",
        },
      },
      context: {
        baseSha: "abc1234",
        changeClass: "high_risk",
        changedFiles: ["src/worker.ts"],
        changedLines: 12,
        diff: "diff",
        patchIdentity: "sha256:patch",
        repositoryDocs: [],
        targetSha: "def5678",
        verificationRecordId: "verification-1",
      },
      database: opened.database,
      endedAt: "t3",
      issue,
      newId: () => "terminal-1",
      reservationId: "reservation-1",
      safety,
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "result_invalid",
    });
    expect(
      opened.sqlite.prepare("select failure_class from attempts where id = 'adjudication-1'").get(),
    ).toEqual({ failure_class: "agent_process" });
    expect(opened.sqlite.prepare("select count(*) as count from review_records").get()).toEqual({
      count: 0,
    });
    expect(safety.canDispatch()).toBe(true);
    await opened.close();
  });
});

function seed(sqlite: ReturnType<typeof openDatabase>["sqlite"]): void {
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values ('adjudication-1', 'issue', 'issue-1', 'adjudication', 1, '/work/issue-1',
        'config-1', 'deep', 'model', 'high', '[]', 'high_risk', 't2', 'running')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at, expires_at,
        origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Running', 't2', 't2', 't9',
        'In Progress', 'adjudication')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_ledgers (
        id, scope, scope_id, unit, base_limit, adjustment, effective_limit,
        reserved, consumed, overrun, version, updated_at
      ) values ('ledger-1', 'attempt', 'adjudication-1', 'tokens', 100, 0, 100, 0, 0, 0, 1,
        't2')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_reservations (
        id, work_ref_kind, work_ref_id, attempt_id, estimated_amounts_json,
        actual_amounts_json, status, created_at, updated_at
      ) values ('reservation-1', 'issue', 'issue-1', 'adjudication-1',
        '{"ledger-1":0}', '{}', 'reserved', 't2', 't2')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_reservation_ledgers (reservation_id, ledger_id, reserved_amount)
       values ('reservation-1', 'ledger-1', 0)`,
    )
    .run();
}
