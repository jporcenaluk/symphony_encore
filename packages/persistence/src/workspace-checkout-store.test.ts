import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";
import { loadWorkspaceCheckout, recordWorkspaceCheckout } from "./workspace-checkout-store.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-workspace-checkout-"));
  opened = openDatabase(path.join(directory, "state.sqlite3"));
  await applyMigrations(opened.database);
  opened.sqlite
    .prepare("insert into config_snapshots values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("config-1", "t0", "wf", 0, "{}", "{}", "{}", "{}", "prompt", "{}");
  opened.sqlite
    .prepare(
      `insert into attempts (
        id, work_ref_kind, work_ref_id, role, attempt_number, workspace_path,
        config_snapshot_id, compute_profile, model, reasoning_effort, price_table_version,
        routing_reasons_json, change_class, started_at, ended_at, status,
        terminal_result_id, failure_class, input_tokens, output_tokens, total_tokens, cost_usd
      ) values (
        'attempt-1', 'issue', 'issue-1', 'implementation', 1, '/tmp/work/ORG_repo_1',
        'config-1', 'standard', 'model', 'medium', null, '[]', 'standard',
        '2026-07-13T10:00:00Z', null, 'created', null, null, 0, 0, 0, null
      )`,
    )
    .run();
  opened.sqlite
    .prepare(
      `insert into claims (
        work_ref_kind, work_ref_id, holder, mode, acquired_at, updated_at,
        expires_at, origin_stage, reason
      ) values (
        'issue', 'issue-1', 'run-1', 'Running', '2026-07-13T10:00:00Z',
        '2026-07-13T10:00:00Z', '2026-07-13T10:02:00Z', 'Todo', 'dispatch'
      )`,
    )
    .run();
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const checkout = {
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  checkoutMethod: "trusted_repository_adapter" as const,
  createdAt: "2026-07-13T10:00:02Z",
  localBranch: "symphony/ORG_repo_1",
  repository: "ORG/repo",
  workRef: { id: "issue-1", kind: "issue" as const },
  workspacePath: "/tmp/work/ORG_repo_1",
};

describe("workspace checkout provenance", () => {
  it("records one replay-safe checkout for the active claimed workspace", async () => {
    await expect(recordWorkspaceCheckout(opened.database, checkout)).resolves.toEqual({
      created: true,
    });
    await expect(recordWorkspaceCheckout(opened.database, checkout)).resolves.toEqual({
      created: false,
    });
    await expect(loadWorkspaceCheckout(opened.database, checkout.workRef)).resolves.toEqual(
      checkout,
    );
  });

  it("rejects changed provenance and paths not owned by the active attempt", async () => {
    await recordWorkspaceCheckout(opened.database, checkout);
    await expect(
      recordWorkspaceCheckout(opened.database, {
        ...checkout,
        baseSha: "abcdef0123456789abcdef0123456789abcdef01",
      }),
    ).rejects.toThrow("workspace.checkout_conflict");
    await expect(
      recordWorkspaceCheckout(opened.database, {
        ...checkout,
        workRef: { id: "issue-2", kind: "issue" },
      }),
    ).rejects.toThrow("workspace.claimed_attempt_missing");
  });
});
