import type { ActiveServiceState, ControlState, EventRecord } from "@symphony/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ControlApi, createControlApi } from "./control-api.js";

const servers: ControlApi[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fixture(input?: { capabilities?: readonly string[]; authenticated?: boolean }) {
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
        capabilities: input?.capabilities ?? ["operator.read"],
        operatorId: "operator-1",
      };
    },
    async readControlState() {
      return { ...state, service_run: { ...state.service_run, status: serviceState } };
    },
    async readServiceStatus() {
      return { id: "run-1", state: serviceState };
    },
    listEvents,
    streamEvents,
  });
  servers.push(server);
  return {
    listEvents,
    server,
    setServiceState: (value: ActiveServiceState) => (serviceState = value),
    streamEvents,
  };
}

describe("Control API", () => {
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
