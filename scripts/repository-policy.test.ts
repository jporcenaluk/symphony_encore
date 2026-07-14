import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("keeps generated verification artifacts outside the Biome source set", async () => {
  const config = JSON.parse(await readFile(path.join(process.cwd(), "biome.json"), "utf8")) as {
    files: { includes: string[] };
  };

  assert.ok(config.files.includes.includes("!!**/playwright-report"));
  assert.ok(config.files.includes.includes("!!**/test-results"));
  assert.ok(config.files.includes.includes("!!**/artifacts"));
});

test("keeps editorial traceability outside the conformance dependency closure", async () => {
  const root = process.cwd();
  const visited = new Set<string>();
  const pending = ["scripts/conformance-command.ts"];
  const relativeImport =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s+)?["'](\.[^"']+)["']/gu;
  const relativeCall = /\b(?:import|require)\(\s*["'](\.[^"']+)["']\s*\)/gu;
  const computedCall = /\b(?:import|require)\(\s*(?!["'])/u;
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(source, computedCall, `${file} must not compute a dependency`);
    for (const pattern of [relativeImport, relativeCall]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const resolved = path
          .normalize(path.join(path.dirname(file), specifier))
          .replace(/\.js$/u, ".ts");
        if (resolved.startsWith("scripts/")) pending.push(resolved);
      }
    }
  }

  assert(visited.has("scripts/conformance-report.ts"));
  assert(visited.has("scripts/conformance-evidence.ts"));
  assert(!visited.has("scripts/traceability-status.ts"));
});

test("installs and verifies the pinned Linux sandbox runtime before verification", async () => {
  const source = await readFile(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const sandboxInstall = source.match(
    / {6}- name: Install pinned Linux sandbox runtime\n([\s\S]*?)(?=\n {6}- )/u,
  )?.[0];

  assert(sandboxInstall, "expected the verify job to install the Linux sandbox runtime");
  assert.match(sandboxInstall, /if: runner\.os == 'Linux'/u);
  assert.match(sandboxInstall, /BUBBLEWRAP_VERSION: 0\.9\.0-1ubuntu0\.1/u);
  assert.match(
    sandboxInstall,
    /apt-get install --no-install-recommends --yes "bubblewrap=\$\{BUBBLEWRAP_VERSION\}"/u,
  );
  assert.match(sandboxInstall, /dpkg-query[\s\S]*installed_version/u);
  assert.match(sandboxInstall, /test "\$installed_version" = "\$BUBBLEWRAP_VERSION"/u);
  assert.match(sandboxInstall, /test "\$\(command -v bwrap\)" = \/usr\/bin\/bwrap/u);
  assert.match(
    sandboxInstall,
    /install --owner=root --group=root --mode=0644 \.github\/apparmor\/usr\.bin\.bwrap \/etc\/apparmor\.d\/symphony-encore-bwrap/u,
  );
  assert.match(
    sandboxInstall,
    /apparmor_parser --replace \/etc\/apparmor\.d\/symphony-encore-bwrap/u,
  );
  assert.match(
    sandboxInstall,
    /grep --fixed-strings --quiet "symphony-encore-bwrap" \/sys\/kernel\/security\/apparmor\/profiles/u,
  );
  const profileInstall = sandboxInstall.indexOf(
    "install --owner=root --group=root --mode=0644 .github/apparmor/usr.bin.bwrap",
  );
  const profileLoad = sandboxInstall.indexOf(
    "apparmor_parser --replace /etc/apparmor.d/symphony-encore-bwrap",
  );
  const profileVerify = sandboxInstall.indexOf(
    'grep --fixed-strings --quiet "symphony-encore-bwrap"',
  );
  assert(profileInstall >= 0 && profileInstall < profileLoad && profileLoad < profileVerify);
  assert(source.indexOf(sandboxInstall) < source.indexOf("      - run: make verify-fast"));
});

test("grants only the pinned Bubblewrap executable the Ubuntu user-namespace exception", async () => {
  const profile = await readFile(
    path.join(process.cwd(), ".github", "apparmor", "usr.bin.bwrap"),
    "utf8",
  );

  assert.equal(
    profile,
    `# Ubuntu 24.04 restricts unprivileged user namespaces to explicitly named
# applications. Bubblewrap creates the namespace that enforces Encore's
# subprocess sandbox, so grant only the pinned system executable that ability.
abi <abi/4.0>,
include <tunables/global>

profile symphony-encore-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
`,
  );
});

test("holds every Dependabot version ecosystem for the reviewed cooldown", async () => {
  const source = await readFile(path.join(process.cwd(), ".github", "dependabot.yml"), "utf8");
  const updaterBlocks = source.split(/^ {2}- package-ecosystem: /mu).slice(1);

  assert.equal(updaterBlocks.length, 3);
  for (const ecosystem of ["npm", "github-actions", "docker"]) {
    const block = updaterBlocks.find((candidate) => candidate.startsWith(`${ecosystem}\n`));
    assert(block, `expected ${ecosystem} updater`);
    assert.match(block, /^ {4}cooldown:\n {6}default-days: 7$/mu);
  }
});

test("runs least-privilege Gitleaks scans for PR, merge queue, and release events", async () => {
  const ci = await readFile(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const ciAction = ci.match(
    / {6}- if: github\.event_name != 'merge_group'\n {8}uses: gitleaks\/gitleaks-action@[a-f0-9]{40}[^\n]*\n([\s\S]*?)(?=\n {6}- )/u,
  )?.[0];
  assert(ciAction, "expected the supported-event Gitleaks action in ci.yml");
  assert.match(ciAction, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(ciAction, /GITLEAKS_ENABLE_COMMENTS: "false"/u);
  assert.match(
    ci,
    /supply-chain:[\s\S]*?permissions:\n {6}contents: read[^\n]*\n {6}pull-requests: read/u,
  );
  const mergeScan = ci.match(
    / {6}- name: Scan merge-group commits with pinned Gitleaks\n([\s\S]*?)(?=\n {6}- )/u,
  )?.[0];
  assert(mergeScan, "expected a direct merge-group Gitleaks scan");
  assert.match(mergeScan, /if: github\.event_name == 'merge_group'/u);
  assert.match(mergeScan, /GITLEAKS_VERSION: 8\.30\.1/u);
  assert.match(
    mergeScan,
    /GITLEAKS_ARCHIVE_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u,
  );
  assert.match(mergeScan, /\[\[ "\$BASE_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(mergeScan, /\[\[ "\$HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(mergeScan, /curl --fail --location --silent --show-error/u);
  assert.match(
    mergeScan,
    /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}\/gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/u,
  );
  assert.match(mergeScan, /sha256sum --check/u);
  assert.match(
    mergeScan,
    /tar --extract --gzip --file "\$archive" --directory "\$RUNNER_TEMP" gitleaks/u,
  );
  assert.match(
    mergeScan,
    /test "\$\("\$\{RUNNER_TEMP\}\/gitleaks" version\)" = "\$GITLEAKS_VERSION"/u,
  );
  assert.match(
    mergeScan,
    /"\$\{RUNNER_TEMP\}\/gitleaks" git[\s\S]*--log-opts="\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/u,
  );

  const release = await readFile(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8",
  );
  assert.match(
    release,
    /secret-scan:\n {4}name: secret scan\n {4}permissions:\n {6}contents: read/u,
  );
  const releaseScan = release.match(
    / {6}- name: Scan the immutable release commit with pinned Gitleaks\n([\s\S]*?)(?=\n {2}[a-z]|\n {6}- )/u,
  )?.[0];
  assert(releaseScan, "expected the release job to scan its exact commit with the pinned CLI");
  assert.match(releaseScan, /SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(releaseScan, /GITLEAKS_VERSION: 8\.30\.1/u);
  assert.match(
    releaseScan,
    /GITLEAKS_ARCHIVE_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u,
  );
  assert.match(releaseScan, /\[\[ "\$SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(releaseScan, /curl --fail --location --silent --show-error/u);
  assert.match(
    releaseScan,
    /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}\/gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/u,
  );
  assert.match(releaseScan, /sha256sum --check/u);
  assert.match(
    releaseScan,
    /tar --extract --gzip --file "\$archive" --directory "\$RUNNER_TEMP" gitleaks/u,
  );
  assert.match(
    releaseScan,
    /test "\$\("\$\{RUNNER_TEMP\}\/gitleaks" version\)" = "\$GITLEAKS_VERSION"/u,
  );
  assert.match(releaseScan, /--log-opts="\$\{SHA\}\^!"/u);
  assert.match(release, /promote:[\s\S]*?needs: \[secret-scan\]/u);
  const promote = release.match(/\n {2}promote:\n([\s\S]*)/u)?.[0] ?? "";
  assert.doesNotMatch(promote, /gitleaks\/gitleaks-action/u);
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

test("rejects bare pnpm in the Playwright web server command", async () => {
  const commonFiles = {
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
  };
  const bareRoot = await fixture({
    ...commonFiles,
    "playwright.config.ts": `export default {
  webServer: {
    command: "pnpm --filter @symphony/web build && pnpm --filter @symphony/web exec vite preview",
  },
};\n`,
  });
  const qualifiedRoot = await fixture({
    ...commonFiles,
    "playwright.config.ts": `export default {
  webServer: {
    command: "corepack pnpm --filter @symphony/web build && corepack pnpm --filter @symphony/web exec vite preview",
  },
};\n`,
  });
  const variableRoot = await fixture({
    ...commonFiles,
    "playwright.config.ts": `const command = \`pnpm --filter @symphony/web build\`;
export default { webServer: [{ command }] };\n`,
  });
  const arrayRoot = await fixture({
    ...commonFiles,
    "playwright.config.ts": `export default {
  webServer: [{ command: "corepack pnpm --filter @symphony/web build" }, { command: \`pnpm --filter @symphony/web exec vite preview\` }],
};\n`,
  });
  const unrelatedRoot = await fixture({
    ...commonFiles,
    "playwright.config.ts": `const unrelated = { command: "pnpm audit" };
export default { webServer: { command: "corepack pnpm exec vite preview" }, unrelated };\n`,
  });

  const bareViolations = await validateRepository(bareRoot);
  const qualifiedViolations = await validateRepository(qualifiedRoot);
  const variableViolations = await validateRepository(variableRoot);
  const arrayViolations = await validateRepository(arrayRoot);
  const unrelatedViolations = await validateRepository(unrelatedRoot);
  assert(
    bareViolations.includes("playwright.config.ts web server must invoke corepack pnpm"),
    JSON.stringify(bareViolations),
  );
  assert(
    !qualifiedViolations.includes("playwright.config.ts web server must invoke corepack pnpm"),
    JSON.stringify(qualifiedViolations),
  );
  for (const violations of [variableViolations, arrayViolations, unrelatedViolations]) {
    assert(
      violations.includes("playwright.config.ts web server must invoke corepack pnpm"),
      JSON.stringify(violations),
    );
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

test("keeps production runtime primitives behind the Node adapter", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "apps/server/src/production-scheduler.ts": `
import { randomUUID } from "node:crypto";
const id = randomUUID();
const iso = new Date().toISOString();
const epoch = Date.now();
const jitter = Math.random();
`,
    "apps/server/src/node-runtime-services.ts": `
import { randomUUID } from "node:crypto";
export const id = randomUUID();
export const iso = new Date().toISOString();
export const epoch = Date.now();
export const jitter = Math.random();
export const timer = setInterval(() => undefined, 1);
clearInterval(timer);
`,
    "packages/orchestration/src/scheduler/service.ts": `
const timer = setInterval(() => undefined, 1);
clearInterval(timer);
`,
  });

  const violations = await validateRepository(root);
  for (const primitive of [
    "node:crypto",
    "randomUUID",
    "zero-argument new Date",
    "Date.now",
    "Math.random",
  ]) {
    assert(
      violations.some(
        (item) => item.includes("production-scheduler.ts") && item.includes(primitive),
      ),
      `expected production scheduler ${primitive} violation: ${JSON.stringify(violations)}`,
    );
  }
  for (const primitive of ["setInterval", "clearInterval"]) {
    assert(
      violations.some((item) => item.includes("scheduler/service.ts") && item.includes(primitive)),
      `expected scheduler service ${primitive} violation: ${JSON.stringify(violations)}`,
    );
  }
  assert(!violations.some((item) => item.includes("node-runtime-services.ts")));
});

test("allows value-based Date construction in the production scheduler", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "apps/server/src/production-scheduler.ts": `
export const expiresAt = new Date(epochMs + leaseTtlMs).toISOString();
`,
    "packages/orchestration/src/scheduler/service.ts": "export class SchedulerService {}\n",
  });

  const violations = await validateRepository(root);
  assert(!violations.some((item) => item.includes("production-scheduler.ts")));
});

test("rejects aliased and global runtime primitives in the production scheduler", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "apps/server/src/production-scheduler.ts": `
import { randomUUID as makeId } from "node:crypto";
const WallDate = globalThis.Date;
const RandomMath = globalThis.Math;
export const id = makeId();
export const iso = new WallDate().toISOString();
export const epoch = WallDate.now();
export const jitter = RandomMath.random();
`,
    "packages/orchestration/src/scheduler/service.ts": "export class SchedulerService {}\n",
  });

  const violations = await validateRepository(root);
  for (const primitive of [
    "node:crypto",
    "randomUUID",
    "zero-argument new Date",
    "Date.now",
    "Math.random",
  ]) {
    assert(
      violations.some(
        (item) => item.includes("production-scheduler.ts") && item.includes(primitive),
      ),
      `expected aliased ${primitive} violation: ${JSON.stringify(violations)}`,
    );
  }
});

test("ignores forbidden primitive spellings in comments and string literals", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "apps/server/src/production-scheduler.ts": `
export const marker = "🧭";
// import { randomUUID } from "node:crypto";
/* new Date(); Date.now(); Math.random(); */
export const documentation = "node:crypto randomUUID new Date() Date.now() Math.random()";
export const value = new Date(epochMs).toISOString();
`,
    "packages/orchestration/src/scheduler/service.ts": `
// setInterval(() => undefined, 1);
export const documentation = "clearInterval(timer)";
`,
  });

  const violations = await validateRepository(root);
  assert(!violations.some((item) => item.includes("production-scheduler.ts")));
  assert(!violations.some((item) => item.includes("scheduler/service.ts")));
});

test("allows server tests, but not server production code, to depend on test support", async () => {
  const common = {
    "package.json": JSON.stringify({
      engines: { node: ">=24.0.0 <25" },
      packageManager: "pnpm@11.12.0",
    }),
    ".node-version": "24.17.0\n",
    Makefile: validMakefile(),
    "pnpm-workspace.yaml": `packages:\n${REQUIRED_WORKSPACES.map((item) => `  - ${item}`).join("\n")}\n`,
    "apps/server/src/index.ts": "export {};\n",
    "packages/test-support/src/index.ts": "export {};\n",
    "packages/test-support/package.json": JSON.stringify({ name: "@symphony/test-support" }),
  };
  const devRoot = await fixture({
    ...common,
    "apps/server/package.json": JSON.stringify({
      name: "@symphony/server",
      devDependencies: { "@symphony/test-support": "workspace:*" },
    }),
  });
  const productionRoot = await fixture({
    ...common,
    "apps/server/package.json": JSON.stringify({
      name: "@symphony/server",
      dependencies: { "@symphony/test-support": "workspace:*" },
    }),
  });

  assert(
    !(await validateRepository(devRoot)).some((item) =>
      item.includes("@symphony/server must not depend on @symphony/test-support"),
    ),
  );
  assert(
    (await validateRepository(productionRoot)).some((item) =>
      item.includes("@symphony/server must not depend on @symphony/test-support"),
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
