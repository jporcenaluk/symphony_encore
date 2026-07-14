import type {
  ActiveServiceState,
  ConfigurationOverrideMutationResponse,
  ControlState,
  EventRecord,
} from "@symphony/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ControlApi, createControlApi } from "./control-api.js";

const servers: ControlApi[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fixture(input?: {
  bootstrap?: boolean;
  capabilities?: readonly string[];
  authenticated?: boolean;
  csrfValid?: boolean;
  secureCookie?: boolean;
}) {
  let serviceState: ActiveServiceState = "recovering";
  const state: ControlState = {
    dispatch_enabled: false,
    mutations_enabled: false,
    service_run: {
      id: "run-1",
      service_version: "0.0.0",
      started_at: "2026-07-13T10:00:00Z",
      status: "recovering",
    },
    version: "state-1",
  };
  const listEvents = vi.fn(async () => ({ has_more: false, items: [], next_cursor: 7 }));
  const mutateConfigurationOverride = vi.fn(
    async (_request: unknown): Promise<ConfigurationOverrideMutationResponse> => ({
      result: "accepted",
      version: 1,
    }),
  );
  const streamEvents = vi.fn((request: { afterCursor: number; signal: AbortSignal }) =>
    (async function* (): AsyncGenerator<EventRecord> {
      yield {
        attempt_id: null,
        change_class: null,
        compute_profile: null,
        cost_usd: null,
        cursor: request.afterCursor + 1,
        event_name: "service.recovery",
        id: "event-live",
        payload: {},
        reason_code: "recovery.progress",
        result: "recorded",
        service_run_id: "run-1",
        timestamp: "2026-07-13T10:00:01Z",
        work_ref: null,
      };
    })(),
  );
  const server = await createControlApi({
    async authenticate(request) {
      if (input?.authenticated === false || request.headers.authorization !== "Session valid") {
        return null;
      }
      return {
        authSubject: "subject-1",
        capabilities: input?.capabilities ?? ["operator.read", "config.write"],
        operatorId: "operator-1",
      };
    },
    async authenticateMutation(request) {
      if (input?.csrfValid === false || request.headers["x-csrf-token"] !== "csrf-valid") {
        return null;
      }
      return {
        authSubject: "subject-1",
        capabilities: input?.capabilities ?? ["operator.read", "config.write"],
        operatorId: "operator-1",
      };
    },
    ...(input?.bootstrap
      ? {
          bootstrap: {
            async complete(request: {
              authSubject: string;
              bootstrapCredential: string;
              confirmedCandidateHash: string;
              password: string;
              trackerLogin: string | null;
            }) {
              return request.bootstrapCredential === "one-time" &&
                request.confirmedCandidateHash === "sha256:candidate"
                ? ({ kind: "completed" } as const)
                : ({ kind: "credential_mismatch" } as const);
            },
            async status() {
              return { candidateHash: "sha256:candidate", kind: "required" as const };
            },
          },
        }
      : {}),
    async login(credentials) {
      if (
        credentials.authSubject !== "local:admin" ||
        credentials.password !== "correct password"
      ) {
        return null;
      }
      return {
        csrfToken: "csrf-secret",
        expiresAt: "2026-07-13T11:00:00Z",
        principal: {
          authSubject: "local:admin",
          capabilities: ["operator.read"],
          operatorId: "operator-1",
        },
        sessionToken: "session-secret",
      };
    },
    async readControlState() {
      return {
        ...state,
        mutations_enabled: serviceState === "ready",
        service_run: { ...state.service_run, status: serviceState },
      };
    },
    async readServiceStatus() {
      return { id: "run-1", state: serviceState };
    },
    listEvents,
    mutateConfigurationOverride,
    sessionCookieSecure: input?.secureCookie ?? false,
    streamEvents,
  });
  servers.push(server);
  return {
    listEvents,
    mutateConfigurationOverride,
    server,
    setServiceState: (value: ActiveServiceState) => (serviceState = value),
    streamEvents,
  };
}

describe("Control API", () => {
  it("exposes loopback-only exact-candidate bootstrap without echoing credentials", async () => {
    const { server } = await fixture({ bootstrap: true });
    await server.ready();

    const status = await server.inject({ url: "/api/v1/bootstrap" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      candidate_hash: "sha256:candidate",
      status: "required",
    });

    const completed = await server.inject({
      method: "POST",
      payload: {
        auth_subject: "local:admin",
        bootstrap_credential: "one-time",
        confirmed_candidate_hash: "sha256:candidate",
        password: "local password",
        tracker_login: null,
      },
      url: "/api/v1/bootstrap",
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ status: "completed" });
    expect(completed.body).not.toContain("one-time");
    expect(completed.body).not.toContain("local password");

    const remote = await server.inject({
      remoteAddress: "203.0.113.7",
      url: "/api/v1/bootstrap",
    });
    expect(remote.statusCode).toBe(404);
  });
  it("keeps Fastify request logging on the shared Pino lifecycle", async () => {
    const { server } = await fixture();
    await server.ready();

    expect(server.log.level).toBe("silent");
  });

  it("creates an HttpOnly same-site session cookie without exposing its opaque token", async () => {
    const { server } = await fixture();
    await server.ready();

    const response = await server.inject({
      method: "POST",
      payload: { auth_subject: "local:admin", password: "correct password" },
      url: "/api/v1/auth/login",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain(
      "symphony_session=session-secret; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      csrf_token: "csrf-secret",
      expires_at: "2026-07-13T11:00:00Z",
      operator: {
        auth_subject: "local:admin",
        capabilities: ["operator.read"],
        operator_id: "operator-1",
      },
    });
    expect(response.body).not.toContain("session-secret");
  });

  it("uses a generic login failure and marks TLS cookies Secure", async () => {
    const { server } = await fixture({ secureCookie: true });
    await server.ready();

    const invalid = await server.inject({
      method: "POST",
      payload: { auth_subject: "local:admin", password: "wrong" },
      url: "/api/v1/auth/login",
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe("invalid_credentials");

    const valid = await server.inject({
      method: "POST",
      payload: { auth_subject: "local:admin", password: "correct password" },
      url: "/api/v1/auth/login",
    });
    expect(valid.headers["set-cookie"]).toContain("; Secure");
  });

  it("applies a CSRF-bound capability-gated configuration override mutation", async () => {
    const { mutateConfigurationOverride, server, setServiceState } = await fixture();
    setServiceState("ready");
    await server.ready();

    const response = await server.inject({
      headers: { authorization: "Session valid", "x-csrf-token": "csrf-valid" },
      method: "PUT",
      payload: {
        expected_version: 0,
        idempotency_key: "override-1",
        operation: "set",
        reason: "slow polling",
        value: 10_000,
      },
      url: "/api/v1/config/overrides/polling.interval_ms",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: "accepted", version: 1 });
    expect(mutateConfigurationOverride).toHaveBeenCalledWith({
      expectedVersion: 0,
      idempotencyKey: "override-1",
      key: "polling.interval_ms",
      operation: "set",
      operator: {
        authSubject: "subject-1",
        capabilities: ["operator.read", "config.write"],
        operatorId: "operator-1",
      },
      reason: "slow polling",
      value: 10_000,
    });
  });

  it("rejects missing CSRF before mutation and maps version conflicts to 409", async () => {
    const invalidCsrf = await fixture({ csrfValid: false });
    invalidCsrf.setServiceState("ready");
    await invalidCsrf.server.ready();
    const request = {
      headers: { authorization: "Session valid", "x-csrf-token": "wrong" },
      method: "PUT" as const,
      payload: {
        expected_version: 0,
        idempotency_key: "override-1",
        operation: "clear",
        reason: "restore default",
      },
      url: "/api/v1/config/overrides/polling.interval_ms",
    };
    const forbidden = await invalidCsrf.server.inject(request);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("csrf_failed");
    expect(invalidCsrf.mutateConfigurationOverride).not.toHaveBeenCalled();

    const conflict = await fixture();
    conflict.setServiceState("ready");
    conflict.mutateConfigurationOverride.mockResolvedValueOnce({
      result: "version_conflict",
      version: 7,
    });
    const response = await conflict.server.inject({
      ...request,
      headers: { authorization: "Session valid", "x-csrf-token": "csrf-valid" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "version_conflict",
        current_version: "7",
        details: { result: "version_conflict", version: 7 },
        message: "The target version changed before this mutation was applied",
      },
    });
  });

  it("keeps configuration mutations disabled until recovery reaches ready", async () => {
    const { mutateConfigurationOverride, server } = await fixture();
    await server.ready();
    const response = await server.inject({
      headers: { authorization: "Session valid", "x-csrf-token": "csrf-valid" },
      method: "PUT",
      payload: {
        expected_version: 0,
        idempotency_key: "override-1",
        operation: "clear",
        reason: "restore default",
      },
      url: "/api/v1/config/overrides/polling.interval_ms",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("mutations_disabled");
    expect(mutateConfigurationOverride).not.toHaveBeenCalled();
  });

  it("keeps liveness available while readiness reports recovery", async () => {
    const { server, setServiceState } = await fixture();
    await server.ready();

    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ service_state: "recovering", status: "healthy" });

    const recovering = await server.inject({ method: "GET", url: "/ready" });
    expect(recovering.statusCode).toBe(503);
    expect(recovering.json()).toEqual({
      error: {
        code: "service_not_ready",
        current_version: "run-1",
        details: { service_state: "recovering" },
        message: "Service recovery is still in progress",
      },
    });

    setServiceState("ready");
    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ service_run_id: "run-1", status: "ready" });
  });

  it("requires an authenticated operator.read capability for state", async () => {
    const { server } = await fixture();
    await server.ready();

    const unauthenticated = await server.inject({ method: "GET", url: "/api/v1/state" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("authentication_required");

    const authorized = await server.inject({
      headers: { authorization: "Session valid" },
      method: "GET",
      url: "/api/v1/state",
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ version: "state-1" });
  });

  it("returns a structured 403 when the operator lacks read authority", async () => {
    const { server } = await fixture({ capabilities: [] });
    await server.ready();

    const response = await server.inject({
      headers: { authorization: "Session valid" },
      method: "GET",
      url: "/api/v1/state",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("capability_required");
  });

  it("returns bounded event pages from a durable resume cursor", async () => {
    const { listEvents, server } = await fixture();
    await server.ready();

    const response = await server.inject({
      headers: { authorization: "Session valid" },
      method: "GET",
      url: "/api/v1/events?after_cursor=7&limit=25",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ has_more: false, items: [], next_cursor: 7 });
    expect(listEvents).toHaveBeenCalledWith({ afterCursor: 7, limit: 25 });
  });

  it("returns the structured 422 envelope for invalid query values", async () => {
    const { server } = await fixture();
    await server.ready();

    const response = await server.inject({
      headers: { authorization: "Session valid" },
      method: "GET",
      url: "/api/v1/events?limit=1001",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_failed",
        current_version: null,
        message: "Request validation failed",
      },
    });
  });

  it("streams durable SSE ids from an explicit resume cursor", async () => {
    const { server, streamEvents } = await fixture();
    await server.ready();

    const response = await server.inject({
      headers: { authorization: "Session valid", "last-event-id": "11" },
      method: "GET",
      url: "/api/v1/events/stream?after_cursor=12",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("id: 13\nevent: symphony.event\ndata:");
    expect(streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({ afterCursor: 12, signal: expect.any(AbortSignal) }),
    );
  });

  it("returns 422 for an unsafe Last-Event-ID cursor", async () => {
    const { server } = await fixture();
    await server.ready();

    const response = await server.inject({
      headers: {
        authorization: "Session valid",
        "last-event-id": "999999999999999999999999999999",
      },
      method: "GET",
      url: "/api/v1/events/stream",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });

  it("generates OpenAPI from the accepted TypeBox route schemas", async () => {
    const { server } = await fixture();
    await server.ready();

    const document = server.swagger();
    expect(document).toMatchObject({ openapi: "3.1.0" });
    expect(document.paths).toHaveProperty("/health");
    expect(document.paths).toHaveProperty("/ready");
    expect(document.paths).toHaveProperty("/api/v1/state");
    expect(document.paths?.["/api/v1/state"]?.get?.security).toEqual([{ sessionCookie: [] }]);
  });
});
