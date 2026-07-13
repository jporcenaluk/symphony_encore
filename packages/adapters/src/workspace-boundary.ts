import { realpath } from "node:fs/promises";
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
