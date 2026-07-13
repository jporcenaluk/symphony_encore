import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseRuntimeOptions } from "./runtime-options.js";

describe("production runtime options", () => {
  it("uses loopback and stable local paths by default", () => {
    expect(parseRuntimeOptions({}, "/srv/symphony")).toEqual({
      databasePath: path.join("/srv/symphony", ".symphony", "symphony.sqlite3"),
      host: "127.0.0.1",
      port: 8080,
      secureCookies: false,
      sessionTtlMs: 28_800_000,
      uiRoot: path.join("/srv/symphony", "apps", "web", "dist"),
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
          SYMPHONY_WORKSPACE_ROOT: "state/workspaces",
        },
        "/srv/symphony",
      ),
    ).toMatchObject({
      databasePath: "/srv/symphony/state/control.sqlite3",
      port: 49_152,
      sessionTtlMs: 60_000,
      uiRoot: "/srv/symphony/build/ui",
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
    ).toMatchObject({ host: "0.0.0.0", secureCookies: true });
    expect(() => parseRuntimeOptions({ SYMPHONY_PORT: "0" }, "/srv/symphony")).toThrow(
      "runtime.invalid_port",
    );
    expect(() => parseRuntimeOptions({ SYMPHONY_SECURE_COOKIES: "yes" }, "/srv/symphony")).toThrow(
      "runtime.invalid_boolean:SYMPHONY_SECURE_COOKIES",
    );
  });
});
