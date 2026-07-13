import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Issue, Plan } from "@symphony/contracts";
import { PersistenceSafetyController } from "@symphony/orchestration";
import { applyMigrations, openDatabase } from "@symphony/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialPlanSubmissionHandler } from "./initial-plan-submission.js";

const directories: string[] = [];
const classificationConfiguration = {
  provisionalClassification: {
    changeClass: "standard" as const,
    floor: null,
    reasons: ["classification.unknown"],
  },
  riskPathPatterns: [] as string[],
  trivialMaxChangedLines: 25,
  trivialPathPatterns: [] as string[],
};

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const issue: Issue = {
  acceptance_criteria: ["Persist the submitted configuration", "Reject stale versions"],
  assignee_id: null,
  blocked_by: [],
  created_at: "2026-07-13T09:00:00Z",
  description: "Implement durable configuration updates.",
  id: "issue-1",
  identifier: "ORG-10",
  labels: [],
  priority: 1,
  repo_name: "repo",
  repo_owner: "owner",
  state: "In Progress",
  title: "Gate the implementation Plan",
  updated_at: "2026-07-13T09:30:00Z",
  url: "https://example.test/issues/10",
};

function plan(): Plan {
  return {
    acceptance_criteria: issue.acceptance_criteria.map((criterion, index) => ({
      criterion_id: `criterion-${index + 1}`,
      criterion_text: criterion,
      planned_evidence: `Test evidence ${index + 1}`,
    })),
    approach: "Persist configuration and enforce optimistic concurrency.",
    approved_by_attempt_id: null,
    created_at: "2026-07-13T10:01:00Z",
    created_by_attempt_id: "attempt-1",
    estimated_changed_lines: 40,
    estimated_files: 2,
    id: "plan-1",
    proposed_paths: ["apps/server/src/configuration.ts", "apps/server/src/configuration.test.ts"],
    revision: 1,
    risk_facts: [],
    status: "draft",
    validated_at: null,
    verification_commands: ["pnpm test configuration.test.ts"],
    work_ref: { issue_id: issue.id },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-plan-submission-"));
  directories.push(directory);
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, status
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, ?,
        'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't0', 'running'
      )`,
    )
    .run(workspacePath);
  return { directory, opened, workspacePath };
}

describe("initial Plan submission boundary", () => {
  it("persists, validates, and projects an accepted Plan before replying", async () => {
    const target = await fixture();
    const handler = createInitialPlanSubmissionHandler({
      attemptId: "attempt-1",
      database: target.opened.database,
      issue,
      now: () => "2026-07-13T10:02:00Z",
      ...classificationConfiguration,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      workspacePath: target.workspacePath,
    });

    await expect(handler(plan())).resolves.toEqual({
      accepted: true,
      message: "Plan revision 1 accepted.",
    });
    expect(target.opened.sqlite.prepare("select status, validated_at from plans").get()).toEqual({
      status: "validated",
      validated_at: "2026-07-13T10:02:00Z",
    });
    await expect(readFile(path.join(target.workspacePath, "PLAN.md"), "utf8")).resolves.toContain(
      "- [ ] Reject stale versions\n  - Planned evidence: Test evidence 2",
    );
    await target.opened.close();
  });

  it("persists a rejected draft and returns every deterministic objection", async () => {
    const target = await fixture();
    const handler = createInitialPlanSubmissionHandler({
      attemptId: "attempt-1",
      database: target.opened.database,
      issue,
      now: () => "2026-07-13T10:02:00Z",
      ...classificationConfiguration,
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      workspacePath: target.workspacePath,
    });
    const invalid = {
      ...plan(),
      acceptance_criteria: [plan().acceptance_criteria[0]],
      estimated_files: 2,
      proposed_paths: ["../outside.ts"],
    } as Plan;

    await expect(handler(invalid)).resolves.toEqual({
      accepted: false,
      message: [
        "Plan revision 1 rejected:",
        "- plan.acceptance_criterion_missing:Reject stale versions",
        "- plan.path_invalid:../outside.ts",
        "- plan.estimated_files_mismatch:2:1",
      ].join("\n"),
    });
    expect(target.opened.sqlite.prepare("select status from plans").get()).toEqual({
      status: "draft",
    });
    await expect(readFile(path.join(target.workspacePath, "PLAN.md"), "utf8")).rejects.toThrow();
    await target.opened.close();
  });

  it("raises a configured risk path and tells the session to stop for Plan review", async () => {
    const target = await fixture();
    const handler = createInitialPlanSubmissionHandler({
      attemptId: "attempt-1",
      database: target.opened.database,
      issue,
      now: () => "2026-07-13T10:02:00Z",
      ...classificationConfiguration,
      riskPathPatterns: ["apps/server/src/**"],
      safety: new PersistenceSafetyController(vi.fn(async () => undefined)),
      workspacePath: target.workspacePath,
    });

    await expect(handler(plan())).resolves.toEqual({
      accepted: true,
      message: "Plan revision 1 validated as high_risk. Stop implementation and report plan_ready.",
    });
    expect(target.opened.sqlite.prepare("select change_class from attempts").get()).toEqual({
      change_class: "high_risk",
    });
    await target.opened.close();
  });
});
