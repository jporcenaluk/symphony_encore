import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { startHttpRuntime } from "./http-runtime.js";

describe("production HTTP runtime", () => {
  it("owns the API and built UI on one server and prints its exact URL", async () => {
    const uiRoot = await mkdtemp(path.join(tmpdir(), "symphony-runtime-ui-"));
    await writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>runtime UI</main>");
    const server = Fastify({ logger: false });
    server.get("/health", async () => ({ status: "healthy" }));
    const lines: string[] = [];
    const listen = vi.fn(async () => "http://127.0.0.1:43123");

    const runtime = await startHttpRuntime({
      host: "127.0.0.1",
      listen,
      output: (line) => lines.push(line),
      port: 8080,
      server,
      uiRoot,
    });

    expect(listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8080 });
    expect(runtime.url).toBe("http://127.0.0.1:43123");
    expect(lines).toEqual(["Symphony Encore UI: http://127.0.0.1:43123"]);
    expect((await server.inject({ url: "/health" })).json()).toEqual({ status: "healthy" });
    expect(
      (await server.inject({ headers: { accept: "text/html" }, url: "/operations" })).body,
    ).toContain("runtime UI");

    await runtime.close();
    await runtime.close();
  });
});
