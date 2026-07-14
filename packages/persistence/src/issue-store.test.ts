import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Issue } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase } from "./database.js";
import { loadIssue, observeIssue, upsertIssue } from "./issue-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const issue: Issue = {
  acceptance_criteria: ["The state survives restart"],
  assignee_id: null,
  blocked_by: [{ id: "issue-0", state: "Done" }],
  created_at: "2026-07-13T10:00:00Z",
  description: "Persist the normalized record",
  id: "issue-1",
  identifier: "WS-1",
  labels: ["backend", "risk:auth"],
  priority: 1,
  repo_name: "wheelsparrow",
  repo_owner: "jporc",
  state: "Todo",
  title: "Persist issues",
  updated_at: "2026-07-13T10:01:00Z",
  url: "https://github.com/jporc/wheelsparrow/issues/1",
};

describe("issue repository", () => {
  it("round-trips normalized issues across database restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-issue-store-"));
    directories.push(directory);
    const filename = path.join(directory, "symphony.sqlite3");

    const first = openDatabase(filename);
    await applyMigrations(first.database);
    await upsertIssue(first.database, issue, "provider-revision-1");
    await first.close();

    const reopened = openDatabase(filename);
    expect(await loadIssue(reopened.database, "issue-1")).toEqual({
      issue,
      providerRevision: "provider-revision-1",
    });
    await reopened.close();
  });

  it("updates mutable provider state without replacing stable identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-issue-store-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    await applyMigrations(opened.database);
    await upsertIssue(opened.database, issue, "provider-revision-1");
    await upsertIssue(
      opened.database,
      { ...issue, state: "In Progress", updated_at: "2026-07-13T10:02:00Z" },
      "provider-revision-2",
    );

    expect(await loadIssue(opened.database, "issue-1")).toMatchObject({
      issue: { identifier: "WS-1", state: "In Progress" },
      providerRevision: "provider-revision-2",
    });
    await opened.close();
  });

  it("atomically opens a baseline and records only observed external lane changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-issue-observation-"));
    directories.push(directory);
    const opened = openDatabase(path.join(directory, "symphony.sqlite3"));
    await applyMigrations(opened.database);

    await expect(
      observeIssue(opened.database, {
        issue,
        observedAt: "2026-07-13T10:02:00Z",
        providerRevision: "provider-revision-1",
        transitionId: "stage-baseline",
      }),
    ).resolves.toEqual({ firstObservation: true, laneChanged: false });
    await expect(
      observeIssue(opened.database, {
        issue: { ...issue, title: "Updated title" },
        observedAt: "2026-07-13T10:02:30Z",
        providerRevision: "provider-revision-2",
        transitionId: "stage-unused",
      }),
    ).resolves.toEqual({ firstObservation: false, laneChanged: false });
    await expect(
      observeIssue(opened.database, {
        issue: { ...issue, state: "Human", updated_at: "2026-07-13T10:03:00Z" },
        observedAt: "2026-07-13T10:03:00Z",
        providerRevision: "provider-revision-3",
        transitionId: "stage-human",
      }),
    ).resolves.toEqual({ firstObservation: false, laneChanged: true });

    expect(
      opened.sqlite
        .prepare(
          `select id, from_stage, to_stage, attempt_id, entered_at, exited_at,
                  duration_ms, timestamp_source, confirmed_external_revision
           from stage_transitions order by rowid`,
        )
        .all(),
    ).toEqual([
      {
        attempt_id: null,
        confirmed_external_revision: null,
        duration_ms: 60_000,
        entered_at: "2026-07-13T10:02:00Z",
        exited_at: "2026-07-13T10:03:00Z",
        from_stage: null,
        id: "stage-baseline",
        timestamp_source: "observed_estimate",
        to_stage: "Todo",
      },
      {
        attempt_id: null,
        confirmed_external_revision: "provider-revision-3",
        duration_ms: null,
        entered_at: "2026-07-13T10:03:00Z",
        exited_at: null,
        from_stage: "Todo",
        id: "stage-human",
        timestamp_source: "observed_estimate",
        to_stage: "Human",
      },
    ]);
    await opened.close();
  });
});
