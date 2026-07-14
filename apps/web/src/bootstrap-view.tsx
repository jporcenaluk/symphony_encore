import {
  type ControlApiClient,
  ControlApiClientError,
  type ErrorEnvelope,
} from "@symphony/contracts";
import { type FormEvent, useState } from "react";

export interface BootstrapDraft {
  authSubject: string;
  bootstrapCredential: string;
  confirmedCandidateHash: string;
  password: string;
  trackerLogin: string;
}

export type BootstrapSubmission =
  | { kind: "completed" }
  | { error: ErrorEnvelope["error"]; kind: "rejected" };

export async function submitBootstrap(
  complete: ControlApiClient["completeBootstrap"],
  draft: BootstrapDraft,
): Promise<BootstrapSubmission> {
  try {
    await complete({
      auth_subject: draft.authSubject,
      bootstrap_credential: draft.bootstrapCredential,
      confirmed_candidate_hash: draft.confirmedCandidateHash,
      password: draft.password,
      tracker_login: draft.trackerLogin.trim() || null,
    });
    return { kind: "completed" };
  } catch (error) {
    return {
      error:
        error instanceof ControlApiClientError
          ? error.envelope.error
          : {
              code: "bootstrap.request_failed",
              current_version: null,
              details: {},
              message: "The local bootstrap request could not be completed",
            },
      kind: "rejected",
    };
  }
}

export function BootstrapView({
  candidateHash,
  completeBootstrap,
  onCompleted,
}: {
  candidateHash: string;
  completeBootstrap: ControlApiClient["completeBootstrap"];
  onCompleted(): void;
}) {
  const [draft, setDraft] = useState<BootstrapDraft>({
    authSubject: "local:admin",
    bootstrapCredential: "",
    confirmedCandidateHash: "",
    password: "",
    trackerLogin: "",
  });
  const [error, setError] = useState<ErrorEnvelope["error"] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await submitBootstrap(completeBootstrap, draft);
    setDraft((current) => ({ ...current, bootstrapCredential: "", password: "" }));
    setSubmitting(false);
    if (result.kind === "completed") onCompleted();
    else setError(result.error);
  }

  return (
    <main className="login-stage bootstrap-stage">
      <section className="login-card bootstrap-card" aria-labelledby="bootstrap-heading">
        <p className="eyebrow">Loopback only / single use</p>
        <h1 id="bootstrap-heading">First-run authority</h1>
        <p className="login-intro">
          Confirm the complete candidate printed by the local service, then create its first durable
          administrator.
        </p>
        <div className="candidate-panel">
          <span>Privileged candidate</span>
          <code>{candidateHash}</code>
        </div>
        {error ? (
          <div className="error-panel" role="alert">
            <strong>{error.code}</strong>
            <span>{error.message}</span>
          </div>
        ) : null}
        <form onSubmit={submit}>
          <label htmlFor="bootstrap-auth-subject">Authentication subject</label>
          <input
            autoComplete="username"
            id="bootstrap-auth-subject"
            onChange={(event) => setDraft({ ...draft, authSubject: event.currentTarget.value })}
            required
            value={draft.authSubject}
          />
          <label htmlFor="confirmed-candidate-hash">Type the complete candidate hash</label>
          <input
            autoComplete="off"
            id="confirmed-candidate-hash"
            onChange={(event) =>
              setDraft({ ...draft, confirmedCandidateHash: event.currentTarget.value })
            }
            required
            value={draft.confirmedCandidateHash}
          />
          <label htmlFor="bootstrap-credential">One-time bootstrap credential</label>
          <input
            autoComplete="off"
            id="bootstrap-credential"
            onChange={(event) =>
              setDraft({ ...draft, bootstrapCredential: event.currentTarget.value })
            }
            required
            type="password"
            value={draft.bootstrapCredential}
          />
          <label htmlFor="bootstrap-password">Local administrator password</label>
          <input
            autoComplete="new-password"
            id="bootstrap-password"
            minLength={12}
            onChange={(event) => setDraft({ ...draft, password: event.currentTarget.value })}
            required
            type="password"
            value={draft.password}
          />
          <label htmlFor="bootstrap-tracker-login">Tracker login (optional)</label>
          <input
            autoComplete="off"
            id="bootstrap-tracker-login"
            onChange={(event) => setDraft({ ...draft, trackerLogin: event.currentTarget.value })}
            value={draft.trackerLogin}
          />
          <button disabled={submitting} type="submit">
            {submitting ? "Committing authority…" : "Create durable administrator"}
          </button>
        </form>
      </section>
    </main>
  );
}
