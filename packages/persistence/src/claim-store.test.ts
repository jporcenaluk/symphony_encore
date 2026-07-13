import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadClaimRecoveryState, promoteDueRetryClaims, renewRunningClaim } from "./claim-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-claims-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

function insertClaim(input: {
  id: string;
  mode: "AwaitingHuman" | "Ready" | "RetryQueued" | "Running";
  expiresAt?: string | null;
  retryDueAt?: string | null;
  questionId?: string | null;
  blockerPredicate?: string | null;
  approvalRequestId?: string | null;
  cursor?: string | null;
}) {
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason, retry_due_at, blocker_predicate,
        question_id, approval_request_id, last_comment_cursor
      ) values ('issue', ?, 'service-1', ?, '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', ?, 'Todo', 'test', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.mode,
      input.expiresAt ?? null,
      input.retryDueAt ?? null,
      input.blockerPredicate ?? null,
      input.questionId ?? null,
      input.approvalRequestId ?? null,
      input.cursor ?? null,
    );
}

describe("claim recovery state", () => {
  it("rebuilds running expiry, ready work, retry delays, and parked predicates/cursors", async () => {
    insertClaim({ id: "running", mode: "Running", expiresAt: "2026-07-13T10:01:00Z" });
    insertClaim({ id: "ready", mode: "Ready" });
    insertClaim({ id: "retry", mode: "RetryQueued", retryDueAt: "2026-07-13T10:05:00Z" });
    insertClaim({
      approvalRequestId: "approval-1",
      blockerPredicate: "dependency:done",
      cursor: "cursor-8",
      id: "human",
      mode: "AwaitingHuman",
      questionId: "question-1",
    });

    await expect(loadClaimRecoveryState(opened.database, "2026-07-13T10:02:00Z")).resolves.toEqual({
      awaitingHuman: [
        expect.objectContaining({
          approval_request_id: "approval-1",
          blocker_predicate: "dependency:done",
          last_comment_cursor: "cursor-8",
          question_id: "question-1",
          work_ref: { issue_id: "human" },
        }),
      ],
      ready: [expect.objectContaining({ work_ref: { issue_id: "ready" } })],
      retries: [
        {
          claim: expect.objectContaining({ work_ref: { issue_id: "retry" } }),
          delayMs: 180_000,
        },
      ],
      running: [
        {
          claim: expect.objectContaining({ work_ref: { issue_id: "running" } }),
          expired: true,
        },
      ],
    });
  });

  it("renews an owned live lease with compare-and-swap semantics", async () => {
    insertClaim({ id: "running", mode: "Running", expiresAt: "2026-07-13T10:01:00Z" });

    await expect(
      renewRunningClaim(opened.database, {
        expectedExpiresAt: "2026-07-13T10:01:00Z",
        holder: "service-1",
        newExpiresAt: "2026-07-13T10:03:00Z",
        renewedAt: "2026-07-13T10:00:30Z",
        workRef: { id: "running", kind: "issue" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      renewRunningClaim(opened.database, {
        expectedExpiresAt: "2026-07-13T10:01:00Z",
        holder: "service-1",
        newExpiresAt: "2026-07-13T10:04:00Z",
        renewedAt: "2026-07-13T10:01:00Z",
        workRef: { id: "running", kind: "issue" },
      }),
    ).rejects.toThrow("claim.lease_not_renewable");
  });

  it("atomically promotes only due retry claims", async () => {
    insertClaim({ id: "due", mode: "RetryQueued", retryDueAt: "2026-07-13T10:01:00Z" });
    insertClaim({ id: "future", mode: "RetryQueued", retryDueAt: "2026-07-13T10:03:00Z" });

    await expect(promoteDueRetryClaims(opened.database, "2026-07-13T10:02:00Z")).resolves.toBe(1);
    expect(
      opened.sqlite
        .prepare("select work_ref_id, mode, retry_due_at from claims order by work_ref_id")
        .all(),
    ).toEqual([
      { mode: "Ready", retry_due_at: null, work_ref_id: "due" },
      { mode: "RetryQueued", retry_due_at: "2026-07-13T10:03:00Z", work_ref_id: "future" },
    ]);
  });
});
