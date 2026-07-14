import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseRuntimeOptions } from "./runtime-options.js";

describe("production runtime options", () => {
  it("uses loopback and stable local paths by default", () => {
    expect(parseRuntimeOptions({}, "/srv/symphony")).toEqual({
      allowNonLoopback: false,
      databasePath: path.join("/srv/symphony", ".symphony", "symphony.sqlite3"),
      host: "127.0.0.1",
      port: 8080,
      secureCookies: false,
      sessionTtlMs: 28_800_000,
      uiRoot: path.join("/srv/symphony", "apps", "web", "dist"),
      workflowPath: path.join("/srv/symphony", "WORKFLOW.md"),
      workspaceRoot: path.join("/srv/symphony", ".symphony", "workspaces"),
    });
  });

  it("normalizes explicit paths and parses bounded numeric values", () => {
    expect(
      parseRuntimeOptions(
        {
          SYMPHONY_DATABASE_PATH: "state/control.sqlite3",
          SYMPHONY_PORT: "49152",
          SYMPHONY_SESSION_TTL_MS: "60000",
          SYMPHONY_UI_ROOT: "build/ui",
          SYMPHONY_WORKFLOW_PATH: "config/WORKFLOW.md",
          SYMPHONY_WORKSPACE_ROOT: "state/workspaces",
        },
        "/srv/symphony",
      ),
    ).toMatchObject({
      databasePath: "/srv/symphony/state/control.sqlite3",
      port: 49_152,
      sessionTtlMs: 60_000,
      uiRoot: "/srv/symphony/build/ui",
      workflowPath: "/srv/symphony/config/WORKFLOW.md",
      workspaceRoot: "/srv/symphony/state/workspaces",
    });
  });

  it("rejects unsafe binding and malformed numeric or boolean options", () => {
    expect(() => parseRuntimeOptions({ SYMPHONY_HOST: "0.0.0.0" }, "/srv/symphony")).toThrow(
      "runtime.non_loopback_ack_required",
    );
    expect(() =>
      parseRuntimeOptions(
        { SYMPHONY_ALLOW_NON_LOOPBACK: "true", SYMPHONY_HOST: "0.0.0.0" },
        "/srv/symphony",
      ),
    ).toThrow("runtime.secure_cookies_required");
    expect(
      parseRuntimeOptions(
        {
          SYMPHONY_ALLOW_NON_LOOPBACK: "true",
          SYMPHONY_HOST: "0.0.0.0",
          SYMPHONY_SECURE_COOKIES: "true",
        },
        "/srv/symphony",
      ),
    ).toMatchObject({ allowNonLoopback: true, host: "0.0.0.0", secureCookies: true });
    expect(() => parseRuntimeOptions({ SYMPHONY_PORT: "0" }, "/srv/symphony")).toThrow(
      "runtime.invalid_port",
    );
    expect(() => parseRuntimeOptions({ SYMPHONY_SECURE_COOKIES: "yes" }, "/srv/symphony")).toThrow(
      "runtime.invalid_boolean:SYMPHONY_SECURE_COOKIES",
    );
  });

  it("hashes trusted bootstrap authority without retaining the credential", () => {
    const options = parseRuntimeOptions(
      {
        SYMPHONY_BOOTSTRAP_AUTH_SUBJECT: "local:admin",
        SYMPHONY_BOOTSTRAP_CREDENTIAL: "one-time-secret",
      },
      "/srv/symphony",
    );

    expect(options).toMatchObject({
      bootstrapAuthSubject: "local:admin",
      bootstrapCredentialHash:
        "sha256:9769f061ca1f0907de3ca4da3f23937ea28a5cea0b048c0b5ee585f73fa92dbc",
    });
    expect(JSON.stringify(options)).not.toContain("one-time-secret");
    expect(() =>
      parseRuntimeOptions({ SYMPHONY_BOOTSTRAP_CREDENTIAL: "orphan" }, "/srv/symphony"),
    ).toThrow("runtime.bootstrap_authority_incomplete");
  });
});
