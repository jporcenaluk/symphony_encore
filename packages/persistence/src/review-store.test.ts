import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewResult } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import {
  commitOrdinaryReviewSet,
  finishReviewAttempt,
  loadPendingIntegrativeReview,
  loadPendingReviewCoordination,
} from "./review-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("integrative review repository", () => {
  it("loads only the passing immutable target and atomically stores a partial review record", async () => {
    const opened = await fixture();

    await expect(
      loadPendingIntegrativeReview(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toEqual({
      baseSha: "abc1234",
      changeClass: "standard",
      configSnapshotId: "config-1",
      implementationAttemptId: "implementation-1",
      targetSha: "def5678",
      verificationRecordId: "verification-1",
      workspacePath: "/work/issue-1",
    });
    opened.sqlite
      .prepare(
        "update claims set mode = 'Running', expires_at = 't9', reason = 'integrative_review'",
      )
      .run();

    const result: ReviewResult = {
      decision: "needs_rework",
      evidence: [{ kind: "commit", sha: "def5678" }],
      findings: [
        {
          behavior: "Failure path loses durable state",
          blocking: true,
          disposition: "Persist before acknowledging completion",
          evidence: [{ kind: "file", path: "src/worker.ts" }],
          id: "finding-1",
          severity: "high",
        },
      ],
      target_sha: "def5678",
    };
    await finishReviewAttempt(opened.database, {
      attemptId: "review-1",
      costUsd: null,
      endedAt: "2026-07-13T10:05:00Z",
      patchIdentity: "sha256:patch",
      reservationId: "reservation-1",
      result,
      reviewRecordId: "review-record-1",
      settledLedgers: [{ actualAmount: 30, id: "ledger-1" }],
      targetBaseSha: "abc1234",
      targetSha: "def5678",
      terminalResultId: "review-result-1",
      usage: { inputTokens: 20, outputTokens: 10 },
      workRef: { id: "issue-1", kind: "issue" },
    });

    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_coordination_required",
    });
    expect(
      opened.sqlite
        .prepare(
          "select reviewer_role, target_sha, target_base_sha, patch_identity, decision, findings_json from review_records",
        )
        .get(),
    ).toEqual({
      decision: "needs_rework",
      findings_json: JSON.stringify(result.findings),
      patch_identity: "sha256:patch",
      reviewer_role: "integrative_review",
      target_base_sha: "abc1234",
      target_sha: "def5678",
    });
    expect(opened.sqlite.prepare("select count(*) as count from review_sets").get()).toEqual({
      count: 0,
    });

    await expect(
      loadPendingReviewCoordination(opened.database, { id: "issue-1", kind: "issue" }),
    ).resolves.toMatchObject({
      changeClass: "standard",
      records: [
        {
          decision: "needs_rework",
          id: "review-record-1",
          reviewer: "integrative_review",
          targetSha: "def5678",
        },
      ],
      targetBaseSha: "abc1234",
      targetSha: "def5678",
      verificationRecordId: "verification-1",
    });
    await commitOrdinaryReviewSet(opened.database, {
      createdAt: "2026-07-13T10:06:00Z",
      id: "review-set-1",
      requiredSpecialistNames: [],
      workRef: { id: "issue-1", kind: "issue" },
    });
    expect(
      opened.sqlite
        .prepare(
          `select decision, required_reviewer_roles_json, required_specialist_names_json,
             review_record_ids_json, unresolved_blocking_finding_ids_json
           from review_sets`,
        )
        .get(),
    ).toEqual({
      decision: "needs_rework",
      required_reviewer_roles_json: '["integrative_review"]',
      required_specialist_names_json: "[]",
      review_record_ids_json: '["review-record-1"]',
      unresolved_blocking_finding_ids_json: '["finding-1"]',
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_rework",
    });
    await opened.close();
  });

  it("does not create a partial ReviewSet when a required specialist is missing", async () => {
    const opened = await fixture();
    opened.sqlite
      .prepare(
        "update claims set mode = 'Running', expires_at = 't9', reason = 'integrative_review'",
      )
      .run();
    await finishReviewAttempt(opened.database, {
      attemptId: "review-1",
      costUsd: null,
      endedAt: "2026-07-13T10:05:00Z",
      patchIdentity: "sha256:patch",
      reservationId: "reservation-1",
      result: { decision: "approve", evidence: [], findings: [], target_sha: "def5678" },
      reviewRecordId: "review-record-1",
      settledLedgers: [{ actualAmount: 0, id: "ledger-1" }],
      targetBaseSha: "abc1234",
      targetSha: "def5678",
      terminalResultId: "review-result-1",
      usage: { inputTokens: 0, outputTokens: 0 },
      workRef: { id: "issue-1", kind: "issue" },
    });

    await expect(
      commitOrdinaryReviewSet(opened.database, {
        createdAt: "2026-07-13T10:06:00Z",
        id: "review-set-1",
        requiredSpecialistNames: ["systems_security"],
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).rejects.toThrow("review_set.reviewer_missing:systems_security");
    expect(opened.sqlite.prepare("select count(*) as count from review_sets").get()).toEqual({
      count: 0,
    });
    expect(opened.sqlite.prepare("select mode, reason from claims").get()).toEqual({
      mode: "Ready",
      reason: "review_coordination_required",
    });
    await opened.close();
  });

  it("rolls back the record and settlement when the supplied target was not verified", async () => {
    const opened = await fixture();
    opened.sqlite
      .prepare(
        "update claims set mode = 'Running', expires_at = 't9', reason = 'integrative_review'",
      )
      .run();
    await expect(
      finishReviewAttempt(opened.database, {
        attemptId: "review-1",
        costUsd: null,
        endedAt: "2026-07-13T10:05:00Z",
        patchIdentity: "sha256:patch",
        reservationId: "reservation-1",
        result: {
          decision: "approve",
          evidence: [],
          findings: [],
          target_sha: "fffffff",
        },
        reviewRecordId: "review-record-1",
        settledLedgers: [{ actualAmount: 0, id: "ledger-1" }],
        targetBaseSha: "abc1234",
        targetSha: "fffffff",
        terminalResultId: "review-result-1",
        usage: { inputTokens: 0, outputTokens: 0 },
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).rejects.toThrow("review.verified_target_missing");
    expect(opened.sqlite.prepare("select count(*) as count from review_records").get()).toEqual({
      count: 0,
    });
    expect(
      opened.sqlite.prepare("select status from attempts where id = 'review-1'").get(),
    ).toEqual({ status: "running" });
    await opened.close();
  });
});

async function fixture(): Promise<OpenedDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-review-store-"));
  directories.push(directory);
  const opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  const sqlite = opened.sqlite;
  sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, routing_reasons_json,
        change_class, started_at, ended_at, status
      ) values
        ('implementation-1', 'issue', 'issue-1', 'implementation', 1, '/work/issue-1',
         'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't0', null, 'running'),
        ('review-1', 'issue', 'issue-1', 'integrative_review', 2, '/work/issue-1',
         'config-1', 'standard', 'model', 'medium', '[]', 'standard', 't2', null, 'running')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into terminal_results (id, attempt_id, role, result_kind, payload_json, created_at)
       values ('implementation-result-1', 'implementation-1', 'implementation',
         'implementation_outcome', '{}', 't1')`,
    )
    .run();
  sqlite
    .prepare(
      `update attempts set ended_at = 't1', status = 'closed',
       terminal_result_id = 'implementation-result-1' where id = 'implementation-1'`,
    )
    .run();
  sqlite
    .prepare(
      `insert into verification_records (
        id, work_ref_kind, work_ref_id, attempt_id, config_snapshot_id, target_revision,
        command_hash, started_at, ended_at, exit_code, result, environment_policy_hash
      ) values (
        'verification-1', 'issue', 'issue-1', 'implementation-1', 'config-1', 'def5678',
        'sha256:command', 't1', 't2', 0, 'passed', 'sha256:environment'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into workspace_checkouts (
        work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
        checkout_method, local_branch, created_at
      ) values (
        'issue', 'issue-1', '/work/issue-1', 'owner/repo', 'abc1234',
        'trusted_repository_adapter', 'symphony/issue-1', 't0'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at, expires_at,
        origin_stage, reason
      ) values ('issue', 'issue-1', 'run-1', 'Ready', 't0', 't2', null,
        'In Progress', 'review_required')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_ledgers (
        id, scope, scope_id, unit, base_limit, adjustment, effective_limit,
        reserved, consumed, overrun, version, updated_at
      ) values ('ledger-1', 'attempt', 'review-1', 'tokens', 100, 0, 100, 30, 0, 0, 1, 't2')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_reservations (
        id, work_ref_kind, work_ref_id, attempt_id, estimated_amounts_json,
        actual_amounts_json, status, created_at, updated_at
      ) values ('reservation-1', 'issue', 'issue-1', 'review-1', '{"ledger-1":30}', '{}',
        'reserved', 't2', 't2')`,
    )
    .run();
  sqlite
    .prepare(
      `insert into budget_reservation_ledgers (reservation_id, ledger_id, reserved_amount)
       values ('reservation-1', 'ledger-1', 30)`,
    )
    .run();
  return opened;
}
