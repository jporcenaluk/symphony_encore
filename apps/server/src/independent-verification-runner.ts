import { createHash } from "node:crypto";

import {
  createNodeWorkspaceCommandRunner,
  readWorkspaceHeadRevision,
  runLinuxVerification,
  type VerificationExecutionResult,
} from "@symphony/adapters";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import {
  type OpenedDatabase,
  type PendingIndependentVerification,
  recordVerificationAndRoute,
} from "@symphony/persistence";

export interface RevisionReadRequest {
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  workspace: string;
  workspaceRoot: string;
}

export interface VerificationRunRequest extends RevisionReadRequest {
  allowlistedEnvironmentNames: readonly string[];
  command: string;
}

export type RevisionReader = (request: RevisionReadRequest) => Promise<string>;
export type VerificationExecutor = (
  request: VerificationRunRequest,
) => Promise<VerificationExecutionResult>;

export async function runPendingIndependentVerification(input: {
  allowlistedEnvironmentNames: readonly string[];
  command: string;
  database: OpenedDatabase["database"];
  execute?: VerificationExecutor;
  newId(): string;
  readRevision?: RevisionReader;
  safety: PersistenceSafetyController;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  target: PendingIndependentVerification;
  timeoutMs: number;
  verifyNoneReason?: string | null;
  workRef: { id: string; kind: "issue" | "system_job" };
  workspaceRoot: string;
}): Promise<{ result: VerificationExecutionResult["result"]; targetRevision: string }> {
  const request = {
    sourceEnvironment: input.sourceEnvironment,
    timeoutMs: input.timeoutMs,
    workspace: input.target.workspacePath,
    workspaceRoot: input.workspaceRoot,
  };
  const targetRevision = await (input.readRevision ?? defaultRevisionReader)(request);
  if (!/^[A-Fa-f0-9]{7,64}$/u.test(targetRevision)) {
    throw new Error("verification.target_revision_invalid");
  }
  const execution =
    input.command === "none"
      ? skippedExecution(input.verifyNoneReason)
      : await (input.execute ?? runLinuxVerification)({
          ...request,
          allowlistedEnvironmentNames: input.allowlistedEnvironmentNames,
          command: input.command,
        });
  const id = input.newId();
  if (!id) throw new Error("verification.identity_invalid");
  try {
    await recordVerificationAndRoute(input.database, {
      attemptId: input.target.attemptId,
      configSnapshotId: input.target.configSnapshotId,
      execution,
      expectedReadyReason: "independent_verification_required",
      id,
      nextReadyReason: execution.result === "passed" ? "review_required" : "verification_rework",
      targetRevision,
      workRef: input.workRef,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
  return { result: execution.result, targetRevision };
}

async function defaultRevisionReader(request: RevisionReadRequest): Promise<string> {
  return readWorkspaceHeadRevision({
    commandRunner: createNodeWorkspaceCommandRunner(),
    environment: request.sourceEnvironment,
    timeoutMs: request.timeoutMs,
    workspace: request.workspace,
    workspaceRoot: request.workspaceRoot,
  });
}

function skippedExecution(reason: string | null | undefined): VerificationExecutionResult {
  if (!reason) throw new Error("verification.none_reason_missing");
  const timestamp = new Date().toISOString();
  return {
    commandHash: sha256("none"),
    endedAt: timestamp,
    environmentPolicyHash: sha256(JSON.stringify({ mode: "none", reason })),
    exitCode: 0,
    result: "passed",
    startedAt: timestamp,
    stderr: "",
    stdout: reason,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
