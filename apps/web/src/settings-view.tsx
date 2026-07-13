import {
  type ControlApiClient,
  ControlApiClientError,
  type ErrorEnvelope,
} from "@symphony/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

export interface ConfigurationOverrideDraft {
  expectedVersion: string;
  key: string;
  operation: "set" | "clear";
  reason: string;
  value: string;
}

export type ConfigurationSubmissionResult =
  | { kind: "accepted"; version: number }
  | {
      draft: ConfigurationOverrideDraft;
      error: ErrorEnvelope["error"];
      kind: "rejected";
    };

export async function submitConfigurationOverride(
  mutate: ControlApiClient["mutateConfigurationOverride"],
  draft: ConfigurationOverrideDraft,
  idempotencyKey: string,
  csrfToken: string,
): Promise<ConfigurationSubmissionResult> {
  const expectedVersion = Number(draft.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    return rejected(draft, "version.invalid", "Expected version must be a non-negative integer");
  }
  let value: unknown;
  if (draft.operation === "set") {
    try {
      value = JSON.parse(draft.value) as unknown;
    } catch {
      return rejected(draft, "value.invalid_json", "Override values must be valid JSON");
    }
  }
  try {
    const response = await mutate(
      draft.key,
      draft.operation === "set"
        ? {
            expected_version: expectedVersion,
            idempotency_key: idempotencyKey,
            operation: "set",
            reason: draft.reason,
            value,
          }
        : {
            expected_version: expectedVersion,
            idempotency_key: idempotencyKey,
            operation: "clear",
            reason: draft.reason,
          },
      csrfToken,
    );
    return { kind: "accepted", version: response.version };
  } catch (error) {
    return {
      draft,
      error:
        error instanceof ControlApiClientError
          ? error.envelope.error
          : {
              code: "control_api.request_failed",
              current_version: null,
              details: {},
              message: "The control service could not apply this mutation",
            },
      kind: "rejected",
    };
  }
}

export function SettingsView({
  csrfToken,
  mutateConfigurationOverride,
  newIdempotencyKey = () => crypto.randomUUID(),
}: {
  csrfToken: string;
  mutateConfigurationOverride: ControlApiClient["mutateConfigurationOverride"];
  newIdempotencyKey?: () => string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConfigurationOverrideDraft>({
    expectedVersion: "0",
    key: "polling.interval_ms",
    operation: "set",
    reason: "",
    value: "5000",
  });
  const [result, setResult] = useState<ConfigurationSubmissionResult | null>(null);
  const mutation = useMutation({
    mutationFn: (submission: { draft: ConfigurationOverrideDraft; idempotencyKey: string }) =>
      submitConfigurationOverride(
        mutateConfigurationOverride,
        submission.draft,
        submission.idempotencyKey,
        csrfToken,
      ),
    onSuccess: async (next) => {
      setResult(next);
      if (next.kind === "accepted") {
        setDraft((current) => ({
          ...current,
          expectedVersion: String(next.version),
          reason: "",
          value: current.operation === "set" ? "" : current.value,
        }));
        await queryClient.invalidateQueries({ queryKey: ["control-state"] });
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate({ draft, idempotencyKey: newIdempotencyKey() });
  }

  return (
    <section className="surface settings-surface" aria-labelledby="settings-heading">
      <header className="surface-heading">
        <div>
          <p className="eyebrow">Explicit authority</p>
          <h1 id="settings-heading">Settings and controls</h1>
        </div>
        <span className="capability-chip">config.write + CSRF</span>
      </header>

      {result?.kind === "rejected" ? (
        <div className="error-panel" role="alert">
          <strong>{result.error.code}</strong>
          <span>{result.error.message}</span>
          {result.error.current_version ? (
            <small>Current version: {result.error.current_version}</small>
          ) : null}
        </div>
      ) : null}
      {result?.kind === "accepted" ? (
        <div className="commit-panel" role="status">
          Committed override version {result.version}. Effective configuration refresh requested.
        </div>
      ) : null}

      <div className="settings-grid">
        <form className="control-form" onSubmit={submit}>
          <label htmlFor="config-key">Configuration key</label>
          <input
            id="config-key"
            onChange={(event) => setDraft({ ...draft, key: event.currentTarget.value })}
            required
            value={draft.key}
          />

          <label htmlFor="expected-version">Expected version</label>
          <input
            id="expected-version"
            inputMode="numeric"
            min="0"
            onChange={(event) => setDraft({ ...draft, expectedVersion: event.currentTarget.value })}
            required
            type="number"
            value={draft.expectedVersion}
          />

          <label htmlFor="operation">Operation</label>
          <select
            id="operation"
            onChange={(event) =>
              setDraft({ ...draft, operation: event.currentTarget.value as "set" | "clear" })
            }
            value={draft.operation}
          >
            <option value="set">Set override</option>
            <option value="clear">Clear override</option>
          </select>

          <label htmlFor="config-value">JSON value</label>
          <textarea
            disabled={draft.operation === "clear"}
            id="config-value"
            onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
            required={draft.operation === "set"}
            rows={5}
            value={draft.value}
          />

          <label htmlFor="mutation-reason">Reason</label>
          <textarea
            id="mutation-reason"
            onChange={(event) => setDraft({ ...draft, reason: event.currentTarget.value })}
            required
            rows={3}
            value={draft.reason}
          />

          <button disabled={mutation.isPending} type="submit">
            {mutation.isPending ? "Applying…" : "Apply durable override"}
          </button>
        </form>

        <aside className="data-panel unavailable-panel">
          <p className="eyebrow">Confirmed configuration</p>
          <h2>Resource unavailable</h2>
          <p>Effective values and source metadata require the configuration read resource.</p>
          <small>Submitted values never appear here until the Control API confirms them.</small>
        </aside>
      </div>
    </section>
  );
}

function rejected(
  draft: ConfigurationOverrideDraft,
  code: string,
  message: string,
): ConfigurationSubmissionResult {
  return {
    draft,
    error: { code, current_version: null, details: {}, message },
    kind: "rejected",
  };
}
