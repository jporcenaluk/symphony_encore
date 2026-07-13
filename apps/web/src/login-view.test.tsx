import { ControlApiClientError, type LoginResponse } from "@symphony/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { attemptLogin, LoginView } from "./login-view.js";

const loginResponse: LoginResponse = {
  csrf_token: "csrf-token",
  expires_at: "2026-07-13T11:00:00Z",
  operator: {
    auth_subject: "local:admin",
    capabilities: ["operator.read", "config.write"],
    operator_id: "operator-1",
  },
};

describe("operator login", () => {
  it("renders an accessible local-operator credential form", () => {
    const markup = renderToStaticMarkup(<LoginView login={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(markup).toContain("Operator sign in");
    expect(markup).toContain('for="auth-subject"');
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain('for="password"');
    expect(markup).toContain('autoComplete="current-password"');
  });

  it("returns only the durable operator session projection after a valid login", async () => {
    const login = vi.fn(async () => loginResponse);

    await expect(attemptLogin(login, "local:admin", "secret password")).resolves.toEqual({
      kind: "authenticated",
      session: {
        csrfToken: "csrf-token",
        expiresAt: "2026-07-13T11:00:00Z",
        operator: loginResponse.operator,
      },
      subject: "local:admin",
    });
    expect(login).toHaveBeenCalledWith({
      auth_subject: "local:admin",
      password: "secret password",
    });
  });

  it("preserves the subject and structured error but never returns the rejected password", async () => {
    const envelope = {
      error: {
        code: "invalid_credentials",
        current_version: null,
        details: {},
        message: "The supplied credentials are invalid",
      },
    };
    const login = vi.fn(async () => {
      throw new ControlApiClientError(401, envelope);
    });

    const result = await attemptLogin(login, "local:admin", "rejected password");
    expect(result).toEqual({
      error: envelope.error,
      kind: "rejected",
      subject: "local:admin",
    });
    expect(JSON.stringify(result)).not.toContain("rejected password");
  });
});
