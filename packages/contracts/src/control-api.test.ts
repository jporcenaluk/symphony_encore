import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ControlStateSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
} from "./control-api.js";

describe("Control API wire contracts", () => {
  it("accepts explicit liveness and readiness states", () => {
    expect(
      Value.Check(HealthResponseSchema, {
        service_state: "recovering",
        status: "healthy",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReadyResponseSchema, {
        service_run_id: "run-1",
        status: "ready",
      }),
    ).toBe(true);
  });

  it("requires the structured error envelope fields", () => {
    expect(
      Value.Check(ErrorEnvelopeSchema, {
        error: {
          code: "service_not_ready",
          current_version: "run-1",
          details: { service_state: "recovering" },
          message: "Service recovery is still in progress",
        },
      }),
    ).toBe(true);
    expect(Value.Check(ErrorEnvelopeSchema, { error: { code: "broken" } })).toBe(false);
  });

  it("keeps control state explicit and versioned", () => {
    expect(
      Value.Check(ControlStateSchema, {
        dispatch_enabled: false,
        mutations_enabled: false,
        service_run: {
          id: "run-1",
          service_version: "0.0.0",
          started_at: "2026-07-13T10:00:00Z",
          status: "recovering",
        },
        version: "state-7",
      }),
    ).toBe(true);
  });
});
