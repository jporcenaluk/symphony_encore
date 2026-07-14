import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import {
  findPassingVerification,
  loadPendingIndependentVerification,
  loadPendingSynthesisVerification,
  loadVerificationEvidence,
  recordSynthesisVerificationAndRoute,
  recordVerification,
  recordVerificationAndRoute,
} from "./verification-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(filename: string) {
  const opened = openDatabase(filename);
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort,
        routing_reasons_json, change_class, started_at, status,
        input_tokens, output_tokens, total_tokens
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "attempt-1",
      "issue",
      "issue-1",
      "implementation",
      1,
      "/work/issue-1",
      "config-1",
      "standard",
      "model",
      "medium",
      "[]",
      "standard",
      "t0",
      "running",
      0,
      0,
      0,
    );
  return opened;
}

const input = {
  attemptId: "attempt-1",
  configSnapshotId: "config-1",
  execution: {
    commandHash: "sha256:command",
    endedAt: "2026-07-13T10:00:01Z",
    environmentPolicyHash: "sha256:environment",
    exitCode: 0,
    result: "passed" as const,
    startedAt: "2026-07-13T10:00:00Z",
    stderr: "",
    stdout: "all checks passed",
  },
  id: "verification-1",
  targetRevision: "target-sha",
  workRef: { id: "issue-1", kind: "issue" as const },
};

describe("independent verification repository", () => {
  it("persists content-addressed evidence and exact guard lookup across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-verification-store-"));
    directories.push(directory);
    const filename = path.join(directory, "symphony.sqlite3");
    const first = await fixture(filename);
    const recorded = await recordVerification(first.database, input);
    expect(recorded.stdoutRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(recorded.stderrRef).toBeNull();
    if (recorded.stdoutRef === null) throw new Error("expected stdout evidence");
    await first.close();

    const restarted = openDatabase(filename);
    const passing = await findPassingVerification(restarted.database, {
      commandHash: "sha256:command",
      configSnapshotId: "config-1",
      environmentPolicyHash: "sha256:environment",
      targetRevision: "target-sha",
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(passing).toMatchObject({ id: "verification-1", result: "passed" });
    expect(await loadVerificationEvidence(restarted.database, recorded.stdoutRef)).toEqual({
      content: "all checks passed",
      mediaType: "text/plain; charset=utf-8",
    });
    expect(
      await findPassingVerification(restarted.database, {
        commandHash: "sha256:different",
        configSnapshotId: "config-1",
        environmentPolicyHash: "sha256:environment",
        targetRevision: "target-sha",
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).toBeUndefined();
    await restarted.close();
  });

  it("rejects oversized evidence without committing a partial record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-verification-store-"));
    directories.push(directory);
    const opened = await fixture(path.join(directory, "symphony.sqlite3"));

    await expect(
      recordVerification(opened.database, {
        ...input,
        execution: { ...input.execution, stdout: "x".repeat(1_048_577) },
      }),
    ).rejects.toThrow("verification.evidence_too_large");
    expect(
      opened.sqlite.prepare("select count(*) as count from verification_records").get(),
    ).toEqual({ count: 0 });
    expect(opened.sqlite.prepare("select count(*) as count from evidence_blobs").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });

  it("loads a typed completed target and atomically routes the verification result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-verification-store-"));
    directories.push(directory);
    const opened = await fixture(path.join(directory, "symphony.sqlite3"));
    const outcome = {
      actions_requested: [],
      confusions: [],
      evidence: [{ command: "make verify-fast", exit_code: 0, kind: "command", result: "passed" }],
      handoff: {
        acceptance_criteria: ["Verification passes"],
        commands: [{ command: "make verify-fast", exit_code: 0 }],
        decisions_fixed: [],
        files_changed: ["src/feature.ts"],
        goal: "Verify independently",
        open_items: [],
        revision: "abc1234",
      },
      status: "completed",
      summary: "Implementation is ready for verification.",
      verification: { command: "make verify-fast", exit_code: 0, result: "passed" },
    };
    opened.sqlite
      .prepare(
        `insert into terminal_results (id, attempt_id, role, result_kind, payload_json, created_at)
         values ('result-1', 'attempt-1', 'implementation', 'implementation_outcome', ?, 't1')`,
      )
      .run(JSON.stringify(outcome));
    opened.sqlite
      .prepare(
        `update attempts set status = 'closed', ended_at = 't1', terminal_result_id = 'result-1'
         where id = 'attempt-1'`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values (
          'issue', 'issue-1', 'run-1', 'Ready', 't0', 't1', null,
          'In Progress', 'independent_verification_required'
        )`,
      )
      .run();

    await expect(
      loadPendingIndependentVerification(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toMatchObject({
      attemptId: "attempt-1",
      configSnapshotId: "config-1",
      outcome: { status: "completed" },
      workspacePath: "/work/issue-1",
    });
    await recordVerificationAndRoute(opened.database, {
      ...input,
      expectedReadyReason: "independent_verification_required",
      nextReadyReason: "review_required",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_required",
    });

    await expect(
      recordVerificationAndRoute(opened.database, {
        ...input,
        expectedReadyReason: "independent_verification_required",
        id: "verification-2",
        nextReadyReason: "review_required",
      }),
    ).rejects.toThrow("verification.claim_not_ready");
    expect(
      opened.sqlite.prepare("select count(*) as count from verification_records").get(),
    ).toEqual({ count: 1 });
    await opened.close();
  });

  it("recovers a revision-pinned synthesis proposal for independent verification", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-synthesis-verification-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    await applyMigrations(opened.database);
    opened.sqlite
      .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
    opened.sqlite
      .prepare(
        `insert into system_jobs (
          id, kind, repository, workspace_path, goal, acceptance_criteria_json,
          config_snapshot_id, status, created_at
        ) values (
          'synthesis-1', 'synthesis', 'owner/repo', '/work/synthesis-1',
          'Synthesize lessons', '["cite lessons"]', 'config-1', 'review', 't0'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into attempts (
          id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
          config_snapshot_id, compute_profile, model, reasoning_effort,
          routing_reasons_json, change_class, started_at, ended_at, status,
          terminal_result_id
        ) values (
          'attempt-synthesis', 'system_job', 'synthesis-1', 'synthesis', 1,
          '/work/synthesis-1', 'config-1', 'deep', 'model', 'high', '[]',
          'standard', 't0', 't1', 'closed', 'result-synthesis'
        )`,
      )
      .run();
    const proposal = {
      branch: "symphony/system-synthesis-1",
      cited_lesson_ids: ["lesson-1"],
      decision: "propose_changes",
      evidence: [{ kind: "commit", sha: "def5678" }],
      handoff: {
        acceptance_criteria: ["cite lessons"],
        commands: [{ command: "make verify-fast", exit_code: 0 }],
        decisions_fixed: [],
        files_changed: ["WORKFLOW.md"],
        goal: "Synthesize lessons",
        open_items: [],
        revision: "def5678",
      },
      pull_request: { base_ref: "main", title: "Improve workflow rules" },
      repository_revision: "def5678",
      rule_changes: [
        {
          action: "add",
          lesson_ids: ["lesson-1"],
          rationale: "Prevent recurrence",
          rule_id: "rule-new",
          text: "Require current-head verification",
        },
      ],
    };
    opened.sqlite
      .prepare(
        `insert into terminal_results (
          id, attempt_id, role, result_kind, payload_json, created_at
        ) values ('result-synthesis', 'attempt-synthesis', 'synthesis',
          'synthesis_result', ?, 't1')`,
      )
      .run(JSON.stringify(proposal));
    opened.sqlite
      .prepare(
        `insert into claims (
          work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
          expires_at, origin_stage, reason
        ) values (
          'system_job', 'synthesis-1', 'run-1', 'Ready', 't0', 't1', null,
          'review', 'synthesis_verification_required'
        )`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into stage_transitions (
          id, work_ref_kind, work_ref_id, from_stage, to_stage, reason,
          attempt_id, entered_at, timestamp_source
        ) values (
          'stage-review', 'system_job', 'synthesis-1', 'running', 'review',
          'synthesis.propose_changes', 'attempt-synthesis',
          '2026-07-13T10:01:00Z', 'observed_estimate'
        )`,
      )
      .run();

    await expect(loadPendingSynthesisVerification(opened.database, "synthesis-1")).resolves.toEqual(
      {
        attemptId: "attempt-synthesis",
        configSnapshotId: "config-1",
        result: proposal,
        workspacePath: "/work/synthesis-1",
      },
    );
    const failedExecution = {
      commandHash: "sha256:command",
      endedAt: "2026-07-13T10:02:00Z",
      environmentPolicyHash: "sha256:environment",
      exitCode: 1,
      result: "failed" as const,
      startedAt: "2026-07-13T10:01:00Z",
      stderr: "test failed",
      stdout: "",
    };
    await expect(
      recordSynthesisVerificationAndRoute(opened.database, {
        attemptId: "attempt-synthesis",
        configSnapshotId: "config-1",
        execution: failedExecution,
        expectedReadyReason: "synthesis_verification_required",
        id: "verification-synthesis-1",
        maxReworkCycles: 2,
        targetRevision: "def5678",
        transitionId: "stage-rework",
        workRef: { id: "synthesis-1", kind: "system_job" },
      }),
    ).resolves.toMatchObject({ route: "rework" });
    expect(opened.sqlite.prepare("select status from system_jobs").get()).toEqual({
      status: "rework",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "synthesis_rework",
    });
    opened.sqlite
      .prepare(
        `update stage_transitions set exited_at = '2026-07-13T10:03:00Z', duration_ms = 60000
         where id = 'stage-rework'`,
      )
      .run();
    opened.sqlite
      .prepare(
        `insert into stage_transitions (
          id, work_ref_kind, work_ref_id, from_stage, to_stage, reason,
          attempt_id, entered_at, timestamp_source
        ) values (
          'stage-review-2', 'system_job', 'synthesis-1', 'rework', 'review',
          'synthesis.propose_changes', 'attempt-synthesis',
          '2026-07-13T10:03:00Z', 'observed_estimate'
        )`,
      )
      .run();
    opened.sqlite.prepare("update system_jobs set status = 'review'").run();
    opened.sqlite.prepare("update claims set reason = 'synthesis_verification_required'").run();
    await expect(
      recordSynthesisVerificationAndRoute(opened.database, {
        attemptId: "attempt-synthesis",
        configSnapshotId: "config-1",
        execution: {
          ...failedExecution,
          endedAt: "2026-07-13T10:04:00Z",
          startedAt: "2026-07-13T10:03:00Z",
        },
        expectedReadyReason: "synthesis_verification_required",
        id: "verification-synthesis-2",
        maxReworkCycles: 2,
        targetRevision: "def5678",
        transitionId: "stage-human",
        workRef: { id: "synthesis-1", kind: "system_job" },
      }),
    ).resolves.toMatchObject({ route: "human" });
    expect(opened.sqlite.prepare("select status from system_jobs").get()).toEqual({
      status: "human",
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "AwaitingHuman",
      reason: "human_review",
    });
    await opened.close();
  });
});
