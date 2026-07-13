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
});
