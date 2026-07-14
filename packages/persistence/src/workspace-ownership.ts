import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface ClaimedWorkspaceOwnership {
  workRef: string;
  workspacePath: string;
}

interface WorkspaceOwnershipRow {
  checkout_workspace_path: string | null;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
  attempt_workspace_path: string | null;
}

export async function listClaimedWorkspaceOwnership(
  database: Kysely<DatabaseSchema>,
): Promise<ClaimedWorkspaceOwnership[]> {
  const result = await sql<WorkspaceOwnershipRow>`
    select claims.work_ref_kind, claims.work_ref_id,
           attempts.workspace_path as attempt_workspace_path,
           workspace_checkouts.workspace_path as checkout_workspace_path
    from claims
    left join attempts
      on attempts.work_ref_kind = claims.work_ref_kind
      and attempts.work_ref_id = claims.work_ref_id
    left join workspace_checkouts
      on workspace_checkouts.work_ref_kind = claims.work_ref_kind
      and workspace_checkouts.work_ref_id = claims.work_ref_id
    order by claims.work_ref_kind, claims.work_ref_id, attempts.attempt_number
  `.execute(database);

  const pathByWorkRef = new Map<string, string>();
  const checkoutPathByWorkRef = new Map<string, string>();
  for (const row of result.rows) {
    const workRef = `${row.work_ref_kind}:${row.work_ref_id}`;
    if (row.attempt_workspace_path === null) throw new Error("workspace.claim_without_attempt");
    const existing = pathByWorkRef.get(workRef);
    if (existing !== undefined && existing !== row.attempt_workspace_path) {
      throw new Error("workspace.assignment_changed");
    }
    pathByWorkRef.set(workRef, row.attempt_workspace_path);
    if (row.checkout_workspace_path !== null) {
      if (row.checkout_workspace_path !== row.attempt_workspace_path) {
        throw new Error("workspace.checkout_assignment_mismatch");
      }
      checkoutPathByWorkRef.set(workRef, row.checkout_workspace_path);
    }
  }

  const ownerByPath = new Map<string, string>();
  return [...checkoutPathByWorkRef.entries()].map(([workRef, workspacePath]) => {
    const existingOwner = ownerByPath.get(workspacePath);
    if (existingOwner !== undefined && existingOwner !== workRef) {
      throw new Error("workspace.cross_work_ownership");
    }
    ownerByPath.set(workspacePath, workRef);
    return { workRef, workspacePath };
  });
}
