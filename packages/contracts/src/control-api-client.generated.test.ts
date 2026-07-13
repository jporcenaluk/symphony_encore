import { describe, expect, it, vi } from "vitest";

import { ControlApiClientError, createControlApiClient } from "./control-api-client.generated.js";

describe("generated Control API client", () => {
  it("calls the generated operation path with same-origin credentials", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ service_state: "recovering", status: "healthy" }),
    );
    const client = createControlApiClient("http://127.0.0.1:3000", fetchImplementation);

    await expect(client.getHealth()).resolves.toEqual({
      service_state: "recovering",
      status: "healthy",
    });
    expect(fetchImplementation).toHaveBeenCalledWith("http://127.0.0.1:3000/health", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "GET",
    });
  });

  it("throws the structured API error for a non-success response", async () => {
    const payload = {
      error: {
        code: "authentication_required",
        current_version: null,
        details: {},
        message: "Authentication is required",
      },
    };
    const client = createControlApiClient("http://127.0.0.1:3000/", async () =>
      Response.json(payload, { status: 401 }),
    );

    const error = await client.getControlState().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlApiClientError);
    expect(error).toMatchObject({ envelope: payload, status: 401 });
  });

  it("posts login credentials without exposing cross-origin cookie behavior", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        csrf_token: "csrf",
        expires_at: "2026-07-13T11:00:00Z",
        operator: {
          auth_subject: "local:admin",
          capabilities: ["operator.read"],
          operator_id: "operator-1",
        },
      }),
    );
    const client = createControlApiClient("http://127.0.0.1:3000", fetchImplementation);

    await client.login({ auth_subject: "local:admin", password: "password" });
    expect(fetchImplementation).toHaveBeenCalledWith("http://127.0.0.1:3000/api/v1/auth/login", {
      body: JSON.stringify({ auth_subject: "local:admin", password: "password" }),
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    });
  });

  it("builds the generated durable event cursor query", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ has_more: false, items: [], next_cursor: 42 }),
    );
    const client = createControlApiClient("http://127.0.0.1:3000", fetchImplementation);

    await expect(client.listEvents({ afterCursor: 42, limit: 25 })).resolves.toMatchObject({
      next_cursor: 42,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/v1/events?after_cursor=42&limit=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("encodes configuration keys and binds the CSRF token to mutation requests", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ result: "accepted", version: 1 }),
    );
    const client = createControlApiClient("http://127.0.0.1:3000", fetchImplementation);
    const input = {
      expected_version: 0,
      idempotency_key: "override-1",
      operation: "set" as const,
      reason: "test",
      value: 5_000,
    };

    await client.mutateConfigurationOverride("polling.interval_ms", input, "csrf-token");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/v1/config/overrides/polling.interval_ms",
      {
        body: JSON.stringify(input),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": "csrf-token",
        },
        method: "PUT",
      },
    );
  });

  it("builds a credentialed EventSource request from the streaming operation", () => {
    const client = createControlApiClient("http://127.0.0.1:3000/", vi.fn());

    expect(client.streamEvents({ afterCursor: 12 })).toEqual({
      url: "http://127.0.0.1:3000/api/v1/events/stream?after_cursor=12",
      withCredentials: true,
    });
  });
});
