import { mkdir, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)|(?:^|_)ACCESS_KEY(?:_|$)/iu;

export function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_ENVIRONMENT_NAME.test(name);
}

export function sanitizeWorkspaceIdentifier(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/gu, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

export function issueWorkspacePath(workspaceRoot: string, identifier: string): string {
  return path.resolve(workspaceRoot, sanitizeWorkspaceIdentifier(identifier));
}

export function systemJobWorkspacePath(
  workspaceRoot: string,
  kind: "synthesis" | "repair",
  id: string,
): string {
  return path.resolve(workspaceRoot, "_system", `${kind}-${sanitizeWorkspaceIdentifier(id)}`);
}

export async function resolveAssignedWorkspace(
  workspaceRoot: string,
  assignedWorkspace: string,
): Promise<string> {
  const resolvedRoot = await realpath(workspaceRoot);
  const resolvedWorkspace = await realpath(assignedWorkspace);
  const relative = path.relative(resolvedRoot, resolvedWorkspace);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("workspace.outside_root");
  }
  return resolvedWorkspace;
}

export interface WorkspaceOwnership {
  workRef: string;
  workspacePath: string;
}

export interface WorkspaceReconciliationResult {
  owned: string[];
  quarantined: { from: string; to: string }[];
}

export async function reconcileWorkspaceOwnership(input: {
  owned: readonly WorkspaceOwnership[];
  quarantineId: string;
  workspaceRoot: string;
}): Promise<WorkspaceReconciliationResult> {
  await mkdir(input.workspaceRoot, { recursive: true });
  const lexicalRoot = path.resolve(input.workspaceRoot);
  const workspaceRoot = await realpath(input.workspaceRoot);
  const ownership = new Map<string, string>();
  const ownedCandidates = new Set<string>();
  const owned: string[] = [];

  for (const record of input.owned) {
    const relative = path.relative(lexicalRoot, path.resolve(record.workspacePath));
    if (!isWorkspaceRelativePath(relative)) throw new Error("workspace.invalid_layout");
    const resolved = await resolveAssignedWorkspace(workspaceRoot, record.workspacePath);
    const currentOwner = ownership.get(resolved);
    if (currentOwner !== undefined && currentOwner !== record.workRef) {
      throw new Error("workspace.cross_work_ownership");
    }
    ownership.set(resolved, record.workRef);
    ownedCandidates.add(path.join(workspaceRoot, relative));
    ownedCandidates.add(resolved);
    owned.push(resolved);
  }

  const candidates = await listWorkspaceCandidates(workspaceRoot);
  const quarantineRoot = path.join(
    workspaceRoot,
    ".quarantine",
    sanitizeWorkspaceIdentifier(input.quarantineId),
  );
  const quarantined: { from: string; to: string }[] = [];

  for (const candidate of candidates) {
    let candidateIdentity = candidate;
    try {
      candidateIdentity = await realpath(candidate);
    } catch {
      // A broken or racing symlink is still unowned and must be moved by its lexical path.
    }
    if (ownedCandidates.has(candidate) && ownership.has(candidateIdentity)) continue;

    const relative = path.relative(workspaceRoot, candidate);
    const destination = path.join(quarantineRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(candidate, destination);
    quarantined.push({ from: candidate, to: destination });
  }

  return { owned, quarantined };
}

function isWorkspaceRelativePath(relative: string): boolean {
  const parts = relative.split(path.sep);
  if (parts.length === 1) {
    return parts[0] !== "" && parts[0] !== ".quarantine" && parts[0] !== "_system";
  }
  return parts.length === 2 && parts[0] === "_system" && parts[1] !== "";
}

async function listWorkspaceCandidates(workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const direct = entries
    .filter(
      (entry) =>
        entry.name !== ".quarantine" &&
        entry.name !== "_system" &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => path.join(workspaceRoot, entry.name))
    .sort();
  const systemEntry = entries.find((entry) => entry.name === "_system");
  if (systemEntry === undefined) return direct;
  if (!systemEntry.isDirectory() || systemEntry.isSymbolicLink()) {
    return [...direct, path.join(workspaceRoot, systemEntry.name)];
  }

  const systemRoot = path.join(workspaceRoot, "_system");
  const system = (await readdir(systemRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(systemRoot, entry.name))
    .sort();
  return [...direct, ...system];
}

export async function prepareWorkerStateDirectories(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await Promise.all(
    [".cache", ".codex", ".config", ".home", ".local/share", ".local/state", ".tmp"].map(
      (directory) => mkdir(path.join(workspace, directory), { recursive: true }),
    ),
  );
}

export function buildScrubbedWorkerEnvironment(
  resolvedWorkspace: string,
  source: Readonly<Record<string, string | undefined>>,
  allowlistedNames: readonly string[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of allowlistedNames) {
    const value = source[name];
    if (value !== undefined && !isSensitiveEnvironmentName(name)) {
      environment[name] = value;
    }
  }

  const temporary = path.join(resolvedWorkspace, ".tmp");
  return {
    ...environment,
    CODEX_HOME: path.join(resolvedWorkspace, ".codex"),
    HOME: path.join(resolvedWorkspace, ".home"),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    XDG_CACHE_HOME: path.join(resolvedWorkspace, ".cache"),
    XDG_CONFIG_HOME: path.join(resolvedWorkspace, ".config"),
    XDG_DATA_HOME: path.join(resolvedWorkspace, ".local", "share"),
    XDG_STATE_HOME: path.join(resolvedWorkspace, ".local", "state"),
  };
}
