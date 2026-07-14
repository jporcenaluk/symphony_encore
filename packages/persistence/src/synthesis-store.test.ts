import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import { loadSynthesisTriggerState } from "./synthesis-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("synthesis trigger state", () => {
  it("loads only post-synthesis completions and the durable evidence inputs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-state-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "state.sqlite3"));
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, repository, workspace_path, goal, acceptance_criteria_json,
          config_snapshot_id, status, created_at, ended_at
        ) values ('synthesis-old', 'synthesis', 'owner/repo', '/work/synthesis-old',
          'old synthesis', '[]', 'config-1', 'done', '2026-07-01T00:00:00Z',
          '2026-07-02T00:00:00Z')`,
      )
      .run();
    const insertStage = opened.sqlite.prepare(
      `insert into stage_transitions (
        id, work_ref_kind, work_ref_id, from_stage, to_stage, reason, entered_at,
        timestamp_source
      ) values (?, 'issue', ?, 'Review', 'Done', 'completed', ?, 'receipt')`,
    );
    insertStage.run("done-before", "issue-before", "2026-07-01T12:00:00Z");
    insertStage.run("done-after-1", "issue-after-1", "2026-07-03T12:00:00Z");
    insertStage.run("done-after-2", "issue-after-2", "2026-07-04T12:00:00Z");
    opened.sqlite
      .prepare(
        `insert into lessons (
          id, created_at, work_ref_kind, work_ref_id, source, text, evidence_json
        ) values ('lesson-old', '2026-07-01T12:00:00Z', 'issue', 'issue-before',
          'confusion', 'old', '[]'),
          ('lesson-new', '2026-07-03T12:00:00Z', 'issue', 'issue-after-1',
          'review_finding', 'new lesson', '[{"kind":"commit","sha":"abc1234"}]')`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into rules (id, text, lesson_ids_json, citation_count, last_cited_at)
        values ('rule-1', 'Preserve evidence', '["lesson-new"]', 2, '2026-07-02T12:00:00Z')`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, repository, workspace_path, goal, acceptance_criteria_json,
          config_snapshot_id, status, created_at
        ) values ('synthesis-active', 'synthesis', 'owner/repo', '/work/synthesis-active',
          'active synthesis', '[]', 'config-1', 'queued', '2026-07-05T00:00:00Z')`,
      )
      .run();

    await expect(
      loadSynthesisTriggerState(opened.database, { ruleDecayIssues: 2 }),
    ).resolves.toEqual({
      activeSynthesisJobs: 1,
      completedIssuesSinceLastSynthesis: 2,
      decayedRuleIds: ["rule-1"],
      lastSynthesisEndedAt: "2026-07-02T00:00:00Z",
      lessons: [
        {
          created_at: "2026-07-03T12:00:00Z",
          evidence: [{ kind: "commit", sha: "abc1234" }],
          id: "lesson-new",
          source: "review_finding",
          text: "new lesson",
          work_ref: { issue_id: "issue-after-1" },
        },
      ],
      metrics: [],
      rules: [
        {
          citation_count: 2,
          id: "rule-1",
          last_cited_at: "2026-07-02T12:00:00Z",
          lesson_ids: ["lesson-new"],
          text: "Preserve evidence",
        },
      ],
    });
    await opened.close();
  });
});
