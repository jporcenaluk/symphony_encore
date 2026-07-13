import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  REQUIRED_MAKE_TARGETS,
  REQUIRED_WORKSPACES,
  validateRepository,
} from "./repository-policy.ts";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-policy-"));
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );
  return root;
}

test("declares the required workspace and Make target contract", () => {
  assert.deepEqual(REQUIRED_WORKSPACES, [
    "apps/server",
    "apps/web",
    "packages/adapters",
    "packages/contracts",
    "packages/domain",
    "packages/observability",
    "packages/orchestration",
    "packages/persistence",
    "packages/test-support",
  ]);
  assert.deepEqual(REQUIRED_MAKE_TARGETS, [
    "setup",
    "dev",
    "build",
    "start",
    "format",
    "lint",
    "typecheck",
    "test",
    "test-integration",
    "test-e2e",
    "image",
    "verify-fast",
    "verify",
  ]);
});

test("accepts an acyclic inward-pointing package graph", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "packages/domain/package.json": JSON.stringify({ name: "@symphony/domain" }),
    "packages/contracts/package.json": JSON.stringify({
      name: "@symphony/contracts",
      dependencies: { "@symphony/domain": "workspace:*" },
    }),
  });

  assert.deepEqual(await validateRepository(root), []);
});

test("rejects forbidden domain dependencies and workspace cycles", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "packages/domain/package.json": JSON.stringify({
      name: "@symphony/domain",
      dependencies: { fastify: "5.10.0", "@symphony/contracts": "workspace:*" },
    }),
    "packages/contracts/package.json": JSON.stringify({
      name: "@symphony/contracts",
      dependencies: { "@symphony/domain": "workspace:*" },
    }),
  });

  const violations = await validateRepository(root);
  assert(violations.some((item) => item.includes("forbidden dependency fastify")));
  assert(violations.some((item) => item.includes("workspace dependency cycle")));
});

test("rejects technologies deferred by the stack contract", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      dependencies: { xstate: "5.0.0" },
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
  });

  assert(
    (await validateRepository(root)).some((item) =>
      item.includes("package.json uses deferred dependency xstate"),
    ),
  );
});

test("rejects workspace dependencies that point outward", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "packages/domain/package.json": JSON.stringify({ name: "@symphony/domain" }),
    "packages/contracts/package.json": JSON.stringify({ name: "@symphony/contracts" }),
    "packages/adapters/package.json": JSON.stringify({ name: "@symphony/adapters" }),
    "packages/orchestration/package.json": JSON.stringify({
      name: "@symphony/orchestration",
      dependencies: { "@symphony/adapters": "workspace:*" },
    }),
  });

  assert(
    (await validateRepository(root)).some((item) =>
      item.includes("@symphony/orchestration must not depend on @symphony/adapters"),
    ),
  );
});

test("rejects Node package builds that resolve production imports to TypeScript source", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "packages/domain/package.json": JSON.stringify({
      name: "@symphony/domain",
      exports: "./src/index.ts",
      scripts: { build: "tsc -p tsconfig.build.json" },
    }),
  });

  assert(
    (await validateRepository(root)).some((item) =>
      item.includes("@symphony/domain production export must resolve to ./dist/index.js"),
    ),
  );
});

test("rejects unresolved conflict markers in repository-owned text", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "src/conflicted.ts":
      "<<<<<<< ours\nconst value = 1;\n=======\nconst value = 2;\n>>>>>>> theirs\n",
  });

  assert(
    (await validateRepository(root)).some((item) => item.includes("unresolved conflict marker")),
  );
});

test("rejects floating GitHub Action references", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v4\n",
  });

  assert(
    (await validateRepository(root)).some((item) =>
      item.includes("must use a full 40-character commit SHA"),
    ),
  );
});

test("rejects mutable or root production container definitions", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Dockerfile: "FROM node:24-slim\nUSER root\nCMD node apps/server/dist/main.js\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
  });

  const violations = await validateRepository(root);
  assert(
    violations.some((item) => item.includes("Dockerfile base images must pin a sha256 digest")),
  );
  assert(
    violations.some((item) => item.includes("Dockerfile must select a non-root numeric user")),
  );
  assert(violations.some((item) => item.includes("Dockerfile CMD must use exec form")));
});
