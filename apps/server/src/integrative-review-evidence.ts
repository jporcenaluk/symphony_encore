import { createHash } from "node:crypto";

import { resolveAssignedWorkspace, type WorkspaceCommandRunner } from "@symphony/adapters";

import type { IntegrativeReviewContext } from "./integrative-review-attempt-planner.js";

const GIT_ENVIRONMENT_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "XDG_CONFIG_HOME"] as const;
const MAXIMUM_DIFF_BYTES = 4 * 1_048_576;
const MAXIMUM_DOC_BYTES = 256 * 1_024;

export async function collectIntegrativeReviewContext(input: {
  baseSha: string;
  changeClass: "standard" | "high_risk";
  commandRunner: WorkspaceCommandRunner;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  targetSha: string;
  timeoutMs: number;
  verificationRecordId: string;
  workspace: string;
  workspaceRoot: string;
}): Promise<IntegrativeReviewContext> {
  assertInput(input);
  const workspace = await resolveAssignedWorkspace(input.workspaceRoot, input.workspace);
  const environment = allowlistedEnvironment(input.sourceEnvironment);
  const request = (arguments_: readonly string[], maxOutputBytes = 1_048_576) => ({
    arguments: ["-C", workspace, ...arguments_],
    command: "git" as const,
    cwd: input.workspaceRoot,
    environment,
    maxOutputBytes,
    timeoutMs: input.timeoutMs,
  });
  const head = await runRequired(input.commandRunner, request(["rev-parse", "HEAD"]));
  if (
    head.stdout.trim().toLocaleLowerCase("en-US") !== input.targetSha.toLocaleLowerCase("en-US")
  ) {
    throw new Error("review.target_sha_changed");
  }
  await runRequired(
    input.commandRunner,
    request(["diff", "--check", input.baseSha, input.targetSha, "--"]),
    "review.diff_check_failed",
  );
  const status = await runRequired(
    input.commandRunner,
    request(["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  if (status.stdout.trim()) throw new Error("review.workspace_dirty");
  const changed = await runRequired(
    input.commandRunner,
    request(["diff", "--name-only", "--no-renames", input.baseSha, input.targetSha, "--"]),
  );
  const changedFiles = changed.stdout.split(/\r?\n/u).filter(Boolean);
  if (changedFiles.length === 0) throw new Error("review.empty_patch");
  const patchArguments = [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    input.baseSha,
    input.targetSha,
    "--",
  ] as const;
  const patch = await runRequired(
    input.commandRunner,
    request(patchArguments, MAXIMUM_DIFF_BYTES),
    "review.diff_read_failed",
  );
  const docs = await runRequired(
    input.commandRunner,
    request([
      "ls-tree",
      "-r",
      "--name-only",
      input.targetSha,
      "--",
      "AGENTS.md",
      "README.md",
      "README.markdown",
      "README.txt",
    ]),
  );
  const repositoryDocs: { content: string; path: string }[] = [];
  let documentBytes = 0;
  for (const documentPath of docs.stdout.split(/\r?\n/u).filter(Boolean)) {
    const document = await runRequired(
      input.commandRunner,
      request(["show", `${input.targetSha}:${documentPath}`], MAXIMUM_DOC_BYTES),
      "review.repository_doc_read_failed",
    );
    documentBytes += Buffer.byteLength(document.stdout, "utf8");
    if (documentBytes > MAXIMUM_DOC_BYTES) throw new Error("review.repository_docs_too_large");
    repositoryDocs.push({ content: document.stdout, path: documentPath });
  }
  return {
    baseSha: input.baseSha,
    changeClass: input.changeClass,
    changedFiles,
    diff: patch.stdout,
    patchIdentity: `sha256:${createHash("sha256").update(patch.stdout).digest("hex")}`,
    repositoryDocs,
    targetSha: input.targetSha,
    verificationRecordId: input.verificationRecordId,
  };
}

function assertInput(input: Parameters<typeof collectIntegrativeReviewContext>[0]): void {
  if (
    !/^[A-Fa-f0-9]{7,64}$/u.test(input.baseSha) ||
    !/^[A-Fa-f0-9]{7,64}$/u.test(input.targetSha) ||
    !input.verificationRecordId ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0
  ) {
    throw new Error("review.evidence_input_invalid");
  }
}

async function runRequired(
  runner: WorkspaceCommandRunner,
  request: Parameters<WorkspaceCommandRunner["run"]>[0],
  failure = "review.git_command_failed",
): Promise<Awaited<ReturnType<WorkspaceCommandRunner["run"]>>> {
  let result: Awaited<ReturnType<WorkspaceCommandRunner["run"]>>;
  try {
    result = await runner.run(request);
  } catch {
    throw new Error(failure);
  }
  if (result.exitCode !== 0) throw new Error(failure);
  return result;
}

function allowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of GIT_ENVIRONMENT_KEYS) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}
