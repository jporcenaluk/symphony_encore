import { createHash } from "node:crypto";
import path from "node:path";

export interface RuntimeOptions {
  bootstrapAuthSubject?: string;
  bootstrapCredentialHash?: string;
  databasePath: string;
  host: string;
  port: number;
  secureCookies: boolean;
  sessionTtlMs: number;
  uiRoot: string;
  workflowPath: string;
  workspaceRoot: string;
}

export function parseRuntimeOptions(
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): RuntimeOptions {
  const host = nonEmpty(environment.SYMPHONY_HOST, "SYMPHONY_HOST") ?? "127.0.0.1";
  const allowNonLoopback = booleanValue(
    environment.SYMPHONY_ALLOW_NON_LOOPBACK,
    "SYMPHONY_ALLOW_NON_LOOPBACK",
  );
  const secureCookies = booleanValue(
    environment.SYMPHONY_SECURE_COOKIES,
    "SYMPHONY_SECURE_COOKIES",
  );
  if (!isLoopback(host) && !allowNonLoopback) throw new Error("runtime.non_loopback_ack_required");
  if (!isLoopback(host) && !secureCookies) throw new Error("runtime.secure_cookies_required");
  const bootstrapAuthSubject = nonEmpty(
    environment.SYMPHONY_BOOTSTRAP_AUTH_SUBJECT,
    "SYMPHONY_BOOTSTRAP_AUTH_SUBJECT",
  );
  const bootstrapCredential = nonEmpty(
    environment.SYMPHONY_BOOTSTRAP_CREDENTIAL,
    "SYMPHONY_BOOTSTRAP_CREDENTIAL",
  );
  if ((bootstrapAuthSubject === undefined) !== (bootstrapCredential === undefined)) {
    throw new Error("runtime.bootstrap_authority_incomplete");
  }

  return {
    ...(bootstrapAuthSubject && bootstrapCredential
      ? {
          bootstrapAuthSubject,
          bootstrapCredentialHash: `sha256:${createHash("sha256")
            .update(bootstrapCredential)
            .digest("hex")}`,
        }
      : {}),
    databasePath: resolveOptionPath(
      environment.SYMPHONY_DATABASE_PATH,
      cwd,
      path.join(".symphony", "symphony.sqlite3"),
      "SYMPHONY_DATABASE_PATH",
    ),
    host,
    port: integerValue(environment.SYMPHONY_PORT, "SYMPHONY_PORT", 8080, 1, 65_535),
    secureCookies,
    sessionTtlMs: integerValue(
      environment.SYMPHONY_SESSION_TTL_MS,
      "SYMPHONY_SESSION_TTL_MS",
      8 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
    ),
    uiRoot: resolveOptionPath(
      environment.SYMPHONY_UI_ROOT,
      cwd,
      path.join("apps", "web", "dist"),
      "SYMPHONY_UI_ROOT",
    ),
    workflowPath: resolveOptionPath(
      environment.SYMPHONY_WORKFLOW_PATH,
      cwd,
      "WORKFLOW.md",
      "SYMPHONY_WORKFLOW_PATH",
    ),
    workspaceRoot: resolveOptionPath(
      environment.SYMPHONY_WORKSPACE_ROOT,
      cwd,
      path.join(".symphony", "workspaces"),
      "SYMPHONY_WORKSPACE_ROOT",
    ),
  };
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`runtime.invalid_boolean:${name}`);
}

function integerValue(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      name === "SYMPHONY_PORT" ? "runtime.invalid_port" : `runtime.invalid_integer:${name}`,
    );
  }
  return parsed;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function nonEmpty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error(`runtime.empty_option:${name}`);
  return value;
}

function resolveOptionPath(
  value: string | undefined,
  cwd: string,
  fallback: string,
  name: string,
): string {
  return path.resolve(cwd, nonEmpty(value, name) ?? fallback);
}
