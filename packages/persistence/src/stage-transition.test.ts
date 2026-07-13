import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { openBaselineStage, transitionStage } from "./stage-transition.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-stage-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "now", "hash", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
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
      "/tmp/work/issue-1",
      "config-1",
      "standard",
      "provider-model",
      "medium",
      "[]",
      "standard",
      "2026-07-13T10:00:00Z",
      "created",
      0,
      0,
      0,
    );
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

describe("durable stage transitions", () => {
  it("opens a baseline and atomically closes it when a receipt confirms the next lane", async () => {
    await openBaselineStage(opened.database, {
      enteredAt: "2026-07-13T10:00:00.000Z",
      id: "stage-1",
      reason: "first_observation",
      timestampSource: "tracker",
      toStage: "Todo",
      workRef: { id: "issue-1", kind: "issue" },
    });
    await transitionStage(opened.database, {
      attemptId: "attempt-1",
      confirmedExternalRevision: "tracker-rev-2",
      enteredAt: "2026-07-13T10:01:30.000Z",
      expectedFromStage: "Todo",
      id: "stage-2",
      reason: "dispatch_receipt",
      timestampSource: "receipt",
      toStage: "In Progress",
      workRef: { id: "issue-1", kind: "issue" },
    });

    expect(
      opened.sqlite
        .prepare(
          "select id, from_stage, to_stage, exited_at, duration_ms, confirmed_external_revision from stage_transitions order by entered_at",
        )
        .all(),
    ).toEqual([
      {
        confirmed_external_revision: null,
        duration_ms: 90_000,
        exited_at: "2026-07-13T10:01:30.000Z",
        from_stage: null,
        id: "stage-1",
        to_stage: "Todo",
      },
      {
        confirmed_external_revision: "tracker-rev-2",
        duration_ms: null,
        exited_at: null,
        from_stage: "Todo",
        id: "stage-2",
        to_stage: "In Progress",
      },
    ]);
  });

  it("rejects a stale expected stage and preserves the existing open transition", async () => {
    await openBaselineStage(opened.database, {
      enteredAt: "2026-07-13T10:00:00.000Z",
      id: "stage-1",
      reason: "first_observation",
      timestampSource: "observed_estimate",
      toStage: "Todo",
      workRef: { id: "issue-1", kind: "issue" },
    });

    await expect(
      transitionStage(opened.database, {
        attemptId: "attempt-1",
        confirmedExternalRevision: "tracker-rev-2",
        enteredAt: "2026-07-13T10:01:30.000Z",
        expectedFromStage: "Review",
        id: "stage-2",
        reason: "stale_receipt",
        timestampSource: "receipt",
        toStage: "Done",
        workRef: { id: "issue-1", kind: "issue" },
      }),
    ).rejects.toThrow("Open stage does not match expected stage Review");
    expect(
      opened.sqlite
        .prepare("select id, exited_at from stage_transitions where work_ref_id = 'issue-1'")
        .all(),
    ).toEqual([{ exited_at: null, id: "stage-1" }]);
  });
});
