import {
  type ControlApiClient,
  ControlApiClientError,
  type ErrorEnvelope,
} from "@symphony/contracts";
import { type FormEvent, useState } from "react";

import type { OperatorSession } from "./api-session.js";

export type LoginAttempt =
  | { kind: "authenticated"; session: OperatorSession; subject: string }
  | { error: ErrorEnvelope["error"]; kind: "rejected"; subject: string };

export async function attemptLogin(
  login: ControlApiClient["login"],
  subject: string,
  password: string,
): Promise<LoginAttempt> {
  try {
    const response = await login({ auth_subject: subject, password });
    return {
      kind: "authenticated",
      session: {
        csrfToken: response.csrf_token,
        expiresAt: response.expires_at,
        operator: response.operator,
      },
      subject,
    };
  } catch (error) {
    return {
      error:
        error instanceof ControlApiClientError
          ? error.envelope.error
          : {
              code: "network_error",
              current_version: null,
              details: {},
              message: "The control service could not be reached",
            },
      kind: "rejected",
      subject,
    };
  }
}

export function LoginView({
  login,
  onAuthenticated,
}: {
  login: ControlApiClient["login"];
  onAuthenticated(session: OperatorSession): void;
}) {
  const [subject, setSubject] = useState("local:admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ErrorEnvelope["error"] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await attemptLogin(login, subject, password);
    setPassword("");
    setSubmitting(false);
    if (result.kind === "authenticated") onAuthenticated(result.session);
    else setError(result.error);
  }

  return (
    <main className="login-stage">
      <section className="login-card" aria-labelledby="login-heading">
        <p className="eyebrow">Local authority / protected console</p>
        <h1 id="login-heading">Operator sign in</h1>
        <p className="login-intro">
          Authenticate against the durable operator store. Credentials stay outside browser state.
        </p>
        {error ? (
          <div className="error-panel" role="alert">
            <strong>{error.code}</strong>
            <span>{error.message}</span>
          </div>
        ) : null}
        <form onSubmit={submit}>
          <label htmlFor="auth-subject">Authentication subject</label>
          <input
            autoComplete="username"
            id="auth-subject"
            name="auth_subject"
            onChange={(event) => setSubject(event.currentTarget.value)}
            required
            value={subject}
          />
          <label htmlFor="password">Password</label>
          <input
            autoComplete="current-password"
            id="password"
            name="password"
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />
          <button disabled={submitting} type="submit">
            {submitting ? "Authenticating…" : "Enter control room"}
          </button>
        </form>
      </section>
    </main>
  );
}
