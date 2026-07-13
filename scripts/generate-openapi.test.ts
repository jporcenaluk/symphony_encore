import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkGeneratedOpenApi, renderOpenApi, writeGeneratedOpenApi } from "./generate-openapi.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("generated OpenAPI contract", () => {
  it("renders every registered Control API route", async () => {
    const document = JSON.parse(await renderOpenApi()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toEqual([
      "/health",
      "/ready",
      "/api/v1/events/stream",
      "/api/v1/events",
      "/api/v1/state",
    ]);
  });

  it("detects stale output and writes the exact generated document", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-openapi-"));
    directories.push(directory);
    const target = path.join(directory, "openapi.json");
    await writeFile(target, "{}\n");
    await expect(checkGeneratedOpenApi(target)).resolves.toBe(false);

    await writeGeneratedOpenApi(target);
    await expect(checkGeneratedOpenApi(target)).resolves.toBe(true);
    expect(await readFile(target, "utf8")).toBe(await renderOpenApi());
  });
});
