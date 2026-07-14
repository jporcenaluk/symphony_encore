import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerOperatorUi } from "./operator-ui.js";

async function uiFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-ui-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><main>operator console</main>");
  await writeFile(path.join(root, "assets", "app-a1b2c3.js"), "window.consoleReady = true;");
  return root;
}

describe("production operator UI hosting", () => {
  it("serves built assets and SPA routes with safe cache and security headers", async () => {
    const server = Fastify({ logger: false });
    await registerOperatorUi(server, { root: await uiFixture() });

    const route = await server.inject({ headers: { accept: "text/html" }, url: "/settings" });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("operator console");
    expect(route.headers["cache-control"]).toBe("no-cache");
    expect(route.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(route.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(route.headers["referrer-policy"]).toBe("no-referrer");
    expect(route.headers["x-content-type-options"]).toBe("nosniff");

    const asset = await server.inject({ url: "/assets/app-a1b2c3.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    await server.close();
  });

  it("never converts missing API or non-HTML requests into the SPA", async () => {
    const server = Fastify({ logger: false });
    await registerOperatorUi(server, { root: await uiFixture() });

    const api = await server.inject({
      headers: { accept: "text/html" },
      url: "/api/v1/not-a-resource",
    });
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-type"]).toContain("application/json");
    expect(api.json()).toEqual({
      error: {
        code: "not_found",
        current_version: null,
        details: {},
        message: "The requested resource does not exist",
      },
    });

    const plain = await server.inject({ headers: { accept: "application/json" }, url: "/history" });
    expect(plain.statusCode).toBe(404);
    expect(plain.headers["content-type"]).toContain("application/json");
    await server.close();
  });
});
