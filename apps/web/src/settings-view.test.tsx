import {
  type ConfigurationOverrideMutationResponse,
  type ControlApiClient,
  ControlApiClientError,
} from "@symphony/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsView, submitConfigurationOverride } from "./settings-view.js";

describe("settings and controls surface", () => {
  it("renders the explicit versioned configuration mutation fields", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView
          csrfToken="csrf"
          mutateConfigurationOverride={vi.fn()}
          newIdempotencyKey={() => "request-1"}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Settings and controls");
    expect(markup).toContain('for="config-key"');
    expect(markup).toContain('for="expected-version"');
    expect(markup).toContain('for="config-value"');
    expect(markup).toContain('for="mutation-reason"');
  });

  it("submits parsed JSON with the exact version, idempotency key, and CSRF token", async () => {
    const mutate = vi.fn(
      async (): Promise<ConfigurationOverrideMutationResponse> => ({
        result: "accepted",
        version: 4,
      }),
    );

    await expect(
      submitConfigurationOverride(
        mutate,
        {
          expectedVersion: "3",
          key: "polling.interval_ms",
          operation: "set",
          reason: "reduce tracker pressure",
          value: "10000",
        },
        "request-1",
        "csrf-token",
      ),
    ).resolves.toEqual({ kind: "accepted", version: 4 });
    expect(mutate).toHaveBeenCalledWith(
      "polling.interval_ms",
      {
        expected_version: 3,
        idempotency_key: "request-1",
        operation: "set",
        reason: "reduce tracker pressure",
        value: 10_000,
      },
      "csrf-token",
    );
  });

  it("returns the submitted draft with structured conflicts and rejects invalid JSON locally", async () => {
    const envelope = {
      error: {
        code: "version_conflict",
        current_version: "7",
        details: { version: 7 },
        message: "The target version changed before this mutation was applied",
      },
    };
    const mutate: ControlApiClient["mutateConfigurationOverride"] = vi.fn(async () => {
      throw new ControlApiClientError(409, envelope);
    });
    const draft = {
      expectedVersion: "3",
      key: "polling.interval_ms",
      operation: "set" as const,
      reason: "preserve this input",
      value: "5000",
    };

    await expect(submitConfigurationOverride(mutate, draft, "request-1", "csrf")).resolves.toEqual({
      draft,
      error: envelope.error,
      kind: "rejected",
    });

    const invalid = { ...draft, value: "not-json" };
    await expect(
      submitConfigurationOverride(mutate, invalid, "request-2", "csrf"),
    ).resolves.toMatchObject({
      draft: invalid,
      error: { code: "value.invalid_json" },
      kind: "rejected",
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
