import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkGeneratedOpenApi,
  renderControlApiClientFromDocument,
  renderOpenApi,
  writeGeneratedOpenApi,
} from "./generate-openapi.js";

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
      "/api/v1/bootstrap",
      "/health",
      "/api/v1/auth/login",
      "/api/v1/config/overrides/{key}",
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

  it("rejects schema-controlled code tokens before client source construction", () => {
    expect(() =>
      renderControlApiClientFromDocument({
        paths: {
          "/health`); globalThis.compromised = true; request(`": {
            get: { operationId: "getHealth" },
          },
        },
      }),
    ).toThrow("openapi.operation_contract_mismatch:getHealth");

    expect(() =>
      renderControlApiClientFromDocument({
        paths: {
          "/health": {
            "get`); globalThis.compromised = true; request(`": { operationId: "getHealth" },
          },
        },
      }),
    ).toThrow("openapi.operation_contract_mismatch:getHealth");

    expect(() =>
      renderControlApiClientFromDocument({
        paths: {
          "/health": {
            get: { operationId: "getHealth(); globalThis.compromised = true" },
          },
        },
      }),
    ).toThrow("openapi.unsupported_operation:getHealth(); globalThis.compromised = true");
  });

  it("renders client source independently of untrusted schema traversal order", async () => {
    const document = JSON.parse(await renderOpenApi()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const reversed = {
      paths: Object.fromEntries(Object.entries(document.paths).reverse()),
    };

    expect(renderControlApiClientFromDocument(reversed)).toBe(
      renderControlApiClientFromDocument(document),
    );
  });

  it("never interpolates operation-derived values into generated TypeScript", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts", "generate-openapi.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\$\{operation\./u);
    expect(source).not.toMatch(/JSON\.stringify\(operation\./u);
  });
});
