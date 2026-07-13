import path from "node:path";

import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface WorkspaceCheckout {
  baseSha: string;
  checkoutMethod: "operator_managed_mirror" | "trusted_repository_adapter";
  createdAt: string;
  localBranch: string;
  repository: string;
  workRef: { id: string; kind: "issue" | "system_job" };
  workspacePath: string;
}

interface WorkspaceCheckoutRow {
  base_sha: string;
  checkout_method: WorkspaceCheckout["checkoutMethod"];
  created_at: string;
  local_branch: string;
  repository: string;
  work_ref_id: string;
  work_ref_kind: WorkspaceCheckout["workRef"]["kind"];
  workspace_path: string;
}

export async function recordWorkspaceCheckout(
  database: Kysely<DatabaseSchema>,
  checkout: WorkspaceCheckout,
): Promise<{ created: boolean }> {
  validateWorkspaceCheckout(checkout);
  return database.transaction().execute(async (transaction) => {
    const assignment = await sql<{ workspace_path: string }>`
      select attempts.workspace_path
      from claims
      join attempts
        on attempts.work_ref_kind = claims.work_ref_kind
        and attempts.work_ref_id = claims.work_ref_id
        and attempts.status in ('created', 'running')
      where claims.work_ref_kind = ${checkout.workRef.kind}
        and claims.work_ref_id = ${checkout.workRef.id}
        and claims.mode = 'Running'
      order by attempts.attempt_number desc
      limit 1
    `.execute(transaction);
    if (assignment.rows[0]?.workspace_path !== checkout.workspacePath) {
      throw new Error("workspace.claimed_attempt_missing");
    }

    const existing = await sql<WorkspaceCheckoutRow>`
      select * from workspace_checkouts
      where work_ref_kind = ${checkout.workRef.kind} and work_ref_id = ${checkout.workRef.id}
    `.execute(transaction);
    const row = existing.rows[0];
    if (row) {
      if (!workspaceCheckoutsEqual(fromRow(row), checkout)) {
        throw new Error("workspace.checkout_conflict");
      }
      return { created: false };
    }
    await sql`
      insert into workspace_checkouts (
        work_ref_kind, work_ref_id, workspace_path, repository, base_sha,
        checkout_method, local_branch, created_at
      ) values (
        ${checkout.workRef.kind}, ${checkout.workRef.id}, ${checkout.workspacePath},
        ${checkout.repository}, ${checkout.baseSha}, ${checkout.checkoutMethod},
        ${checkout.localBranch}, ${checkout.createdAt}
      )
    `.execute(transaction);
    return { created: true };
  });
}

export async function loadWorkspaceCheckout(
  database: Kysely<DatabaseSchema>,
  workRef: WorkspaceCheckout["workRef"],
): Promise<WorkspaceCheckout | undefined> {
  const result = await sql<WorkspaceCheckoutRow>`
    select * from workspace_checkouts
    where work_ref_kind = ${workRef.kind} and work_ref_id = ${workRef.id}
  `.execute(database);
  const row = result.rows[0];
  return row ? fromRow(row) : undefined;
}

function fromRow(row: WorkspaceCheckoutRow): WorkspaceCheckout {
  return {
    baseSha: row.base_sha,
    checkoutMethod: row.checkout_method,
    createdAt: row.created_at,
    localBranch: row.local_branch,
    repository: row.repository,
    workRef: { id: row.work_ref_id, kind: row.work_ref_kind },
    workspacePath: row.workspace_path,
  };
}

function validateWorkspaceCheckout(checkout: WorkspaceCheckout): void {
  if (!/^[A-Fa-f0-9]{7,64}$/u.test(checkout.baseSha)) {
    throw new Error("workspace.base_sha_invalid");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(checkout.repository)) {
    throw new Error("workspace.repository_invalid");
  }
  if (!checkout.localBranch || !path.isAbsolute(checkout.workspacePath)) {
    throw new Error("workspace.checkout_identity_invalid");
  }
  if (!Number.isFinite(Date.parse(checkout.createdAt))) {
    throw new Error("workspace.checkout_timestamp_invalid");
  }
  if (!checkout.workRef.id) throw new Error("workspace.work_ref_invalid");
}

function workspaceCheckoutsEqual(left: WorkspaceCheckout, right: WorkspaceCheckout): boolean {
  return (
    left.baseSha === right.baseSha &&
    left.checkoutMethod === right.checkoutMethod &&
    left.createdAt === right.createdAt &&
    left.localBranch === right.localBranch &&
    left.repository === right.repository &&
    left.workRef.id === right.workRef.id &&
    left.workRef.kind === right.workRef.kind &&
    left.workspacePath === right.workspacePath
  );
}
