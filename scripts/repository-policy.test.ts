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

function validMakefile(): string {
  return [
    "install:",
    "\tcorepack pnpm install --frozen-lockfile",
    "setup: install",
    ...REQUIRED_MAKE_TARGETS.filter((target) => target !== "install" && target !== "setup").flatMap(
      (target) => [`${target}:`, "\t@true"],
    ),
  ].join("\n");
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
    "install",
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
    "conformance",
  ]);
});

test("rejects bare pnpm in root package scripts", async () => {
  const bareCommands = {
    after_assignment: "VERIFY=1 pnpm test",
    after_do: "while false; do pnpm test; done",
    after_newline: "printf ready\npnpm test",
    after_pipe: "printf ready | pnpm test",
    after_then: "if true; then pnpm test; fi",
    in_subshell: "(pnpm test)",
    initial: "pnpm -r --if-present build",
  };
  const qualifiedCommands = {
    qualified_after_assignment: "VERIFY=1 corepack pnpm test",
    qualified_after_do: "while false; do corepack pnpm test; done",
    qualified_after_newline: "printf ready\ncorepack pnpm test",
    qualified_after_pipe: "printf ready | corepack pnpm test",
    qualified_after_then: "if true; then corepack pnpm test; fi",
    qualified_in_subshell: "(corepack pnpm test)",
    qualified_initial: "corepack pnpm -r --if-present build",
  };
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
      scripts: { ...bareCommands, ...qualifiedCommands },
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
  });

  const violations = await validateRepository(root);
  for (const name of Object.keys(bareCommands)) {
    assert(
      violations.includes(`root script ${name} must invoke corepack pnpm`),
      `expected ${name} to be rejected`,
    );
  }
  for (const name of Object.keys(qualifiedCommands)) {
    assert(!violations.includes(`root script ${name} must invoke corepack pnpm`));
  }
});

test("requires fail-closed release preflights and failure-safe publication ordering", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/release.yml": `steps:
  - run: |
      if gh release view "$TAG" >/dev/null 2>&1; then exit 1; fi
  - run: |
      if docker buildx imagetools inspect "$IMAGE:$TAG" >/dev/null 2>&1; then exit 1; fi
  - run: docker buildx imagetools create --tag "$IMAGE:$TAG" "$IMAGE:sha-$SHA"
  - run: image_tag_attempted=true
  - run: gh release create "$TAG" release-assets/*
`,
  });

  const violations = await validateRepository(root);
  assert(
    violations.includes("release.yml GitHub release preflight must fail closed except on HTTP 404"),
  );
  assert(
    violations.includes("release.yml image-tag preflight must fail closed except on not-found"),
  );
  assert(violations.includes("release.yml must finalize release before semantic image promotion"));
  assert(violations.includes("release.yml must clean up release when image promotion fails"));
  assert(
    violations.includes("release.yml must verify promoted digest before completing transaction"),
  );
  assert(
    violations.includes("release.yml must arm uncertain image cleanup before promotion attempt"),
  );
});

test("rejects an unscoped registry not-found classifier", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/release.yml": `steps:
  - run: |
      gh api --include repos/example/releases/tags/v1.0.0
      if [[ "$release_status" != "404" ]]; then echo release.preflight.github.unavailable; fi
      image_probe_error="$RUNNER_TEMP/error"
      grep --quiet 'not found' "$image_probe_error"
      echo release.preflight.image.unavailable
      trap cleanup_release EXIT
      gh release create "$TAG" --draft
      gh release edit "$TAG" --draft=false
      docker buildx imagetools create "$IMAGE:sha-$SHA"
      [[ "$promoted_digest" != "$source_digest" ]]
      if [[ "$image_tag_attempted" == "true" ]]; then echo release.cleanup.image_tag_manual_required; fi
      cleanup_required=false
      gh release delete "$TAG" --yes
`,
  });

  assert(
    (await validateRepository(root)).includes(
      "release.yml image-tag preflight must fail closed except on not-found",
    ),
  );
});

test("accepts only an absence classifier scoped to the exact image tag or manifest path", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/release.yml": `steps:
  - run: |
      gh api --include repos/example/releases/tags/v1.0.0
      if [[ "$release_status" != "404" ]]; then echo release.preflight.github.unavailable; fi
      image_probe_error="$RUNNER_TEMP/error"
      image_reference="\${IMAGE}:\${TAG}"
      registry_manifest_path="/v2/\${REPOSITORY}/manifests/\${TAG}"
      while IFS= read -r provider_line || [[ -n "$provider_line" ]]; do
        provider_line_lower="\${provider_line,,}"
        if [[ "$provider_line_lower" != *"\${image_reference,,}"* && "$provider_line_lower" != *"\${registry_manifest_path,,}"* ]]; then continue; fi
        if [[ "$provider_line_lower" =~ (^|[^[:alnum:]_])(404|manifest[[:space:]]unknown|not[[:space:]]found)([^[:alnum:]_]|$) ]]; then image_absent=true; fi
      done < "$image_probe_error"
      echo release.preflight.image.unavailable
      trap cleanup_release EXIT
      gh release create "$TAG" --draft
      gh release edit "$TAG" --draft=false
      image_tag_attempted=true
      docker buildx imagetools create "$IMAGE:sha-$SHA"
      [[ "$promoted_digest" != "$source_digest" ]]
      if [[ "$image_tag_attempted" == "true" ]]; then echo release.cleanup.image_tag_manual_required; fi
      cleanup_required=false
      gh release delete "$TAG" --yes
`,
  });

  const violations = await validateRepository(root);
  assert(
    !violations.includes("release.yml image-tag preflight must fail closed except on not-found"),
  );
  assert(
    !violations.includes("release.yml must arm uncertain image cleanup before promotion attempt"),
  );
});

test("requires the repository-owned frozen install target and setup dependency", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: REQUIRED_MAKE_TARGETS.map((target) => `${target}:\n\t@true`).join("\n"),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
  });

  const violations = await validateRepository(root);
  assert(
    violations.some((item) =>
      item.includes("Makefile install must use corepack pnpm install --frozen-lockfile"),
    ),
  );
  assert(violations.some((item) => item.includes("Makefile setup must depend on install")));
});

test("rejects workflow portability patterns caught by ShellCheck", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/ci.yml": `steps:
  - run: make install
  - run: make verify-fast
  - run: |
      node -e '
        console.log(\`image: \${process.env.IMAGE}\`);
      '
      sha256sum *.cdx.json > checksums.txt
`,
    ".github/workflows/release.yml": `steps:
  - run: |
      ! gh release view "$TAG"
      ! docker buildx imagetools inspect "$IMAGE:$TAG"
`,
  });

  const violations = await validateRepository(root);
  assert(violations.some((item) => item.includes("SC2016")));
  assert(violations.some((item) => item.includes("SC2035")));
  assert.equal(violations.filter((item) => item.includes("SC2251")).length, 2);
});

test("requires CI verification and publication to use the canonical install target", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    ".github/workflows/ci.yml": `jobs:
  verify:
    steps:
      - run: make install
      - run: make install
      - run: corepack pnpm verify-fast
  publish:
    steps:
      - run: make verify-fast
      - run: make build
`,
  });

  const violations = await validateRepository(root);
  assert(
    violations.some((item) =>
      item.includes("ci.yml verification and publication jobs must use make install"),
    ),
  );
  assert(
    violations.some((item) => item.includes("ci.yml verification job must use make verify-fast")),
  );
});

test("accepts an acyclic inward-pointing package graph", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
    Makefile: validMakefile(),
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
