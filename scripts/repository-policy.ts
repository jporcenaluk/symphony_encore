import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_WORKSPACES = [
  "apps/server",
  "apps/web",
  "packages/adapters",
  "packages/contracts",
  "packages/domain",
  "packages/observability",
  "packages/orchestration",
  "packages/persistence",
  "packages/test-support",
] as const;

export const REQUIRED_MAKE_TARGETS = [
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
] as const;

const FORBIDDEN_DOMAIN_DEPENDENCIES = ["fastify", "react", "kysely", "pino", "better-sqlite3"];
const DEFERRED_DEPENDENCIES = new Set([
  "@tanstack/start",
  "@temporalio/client",
  "@temporalio/worker",
  "@trpc/server",
  "bullmq",
  "electron",
  "graphql",
  "ioredis",
  "next",
  "pg",
  "redis",
  "trpc",
  "ws",
  "xstate",
]);

const ALLOWED_WORKSPACE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "@symphony/adapters": ["@symphony/contracts", "@symphony/domain"],
  "@symphony/contracts": ["@symphony/domain"],
  "@symphony/domain": [],
  "@symphony/observability": ["@symphony/contracts", "@symphony/domain"],
  "@symphony/orchestration": ["@symphony/contracts", "@symphony/domain"],
  "@symphony/persistence": ["@symphony/contracts", "@symphony/domain"],
  "@symphony/server": [
    "@symphony/adapters",
    "@symphony/contracts",
    "@symphony/domain",
    "@symphony/observability",
    "@symphony/orchestration",
    "@symphony/persistence",
  ],
  "@symphony/test-support": [
    "@symphony/adapters",
    "@symphony/contracts",
    "@symphony/domain",
    "@symphony/observability",
    "@symphony/orchestration",
    "@symphony/persistence",
  ],
  "@symphony/web": ["@symphony/contracts"],
};

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  exports?: string | Record<string, unknown>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

async function optionalRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function manifestAt(file: string): Promise<PackageManifest | undefined> {
  const source = await optionalRead(file);
  return source === undefined ? undefined : (JSON.parse(source) as PackageManifest);
}

async function workflowFiles(root: string): Promise<string[]> {
  const directory = path.join(root, ".github", "workflows");
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function repositoryTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const excludedDirectories = new Set([
    ".git",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "test-results",
  ]);

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(target);
      } else if (
        entry.isFile() &&
        (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name === "Makefile")
      ) {
        files.push(target);
      }
    }
  }

  await visit(root);
  return files;
}

function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const trail: string[] = [];

  function visit(node: string): string[] | undefined {
    if (visiting.has(node)) {
      const start = trail.indexOf(node);
      return [...trail.slice(start), node];
    }
    if (visited.has(node)) return undefined;

    visiting.add(node);
    trail.push(node);
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    trail.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

function hasSingleQuotedNodeInterpolation(source: string): boolean {
  for (const match of source.matchAll(/node -e\s+'([^'\n]*)'/gu)) {
    if (match[1]?.includes("${")) return true;
  }
  for (const match of source.matchAll(/node -e\s+'\s*\n([\s\S]*?)^\s*'\s*$/gmu)) {
    if (match[1]?.includes("${")) return true;
  }
  return false;
}

function workflowJobSource(source: string, name: string): string | undefined {
  const start = new RegExp(`^  ${name}:\\s*$`, "mu").exec(source);
  if (!start) return undefined;
  const job = source.slice(start.index + start[0].length);
  const nextJob = /^ {2}[a-zA-Z0-9_-]+:\s*$/mu.exec(job);
  return nextJob ? job.slice(0, nextJob.index) : job;
}

function hasUnqualifiedPnpmToken(command: string): boolean {
  const source = command.replace(/\\\r?\n/gu, " ");
  for (const match of source.matchAll(/\bpnpm\b/gu)) {
    const prefix = source.slice(0, match.index ?? 0);
    if (!/\bcorepack[ \t]+$/u.test(prefix)) return true;
  }
  return false;
}

export async function validateRepository(root: string): Promise<string[]> {
  const violations: string[] = [];
  const rootManifest = await manifestAt(path.join(root, "package.json"));
  const nodeVersion = (await optionalRead(path.join(root, ".node-version")))?.trim();
  const makefile = await optionalRead(path.join(root, "Makefile"));
  const dockerfile = await optionalRead(path.join(root, "Dockerfile"));
  const playwrightConfig = await optionalRead(path.join(root, "playwright.config.ts"));
  const workspace = await optionalRead(path.join(root, "pnpm-workspace.yaml"));

  if (nodeVersion !== "24.17.0") {
    violations.push(".node-version must pin Node.js 24.17.0");
  }
  if (rootManifest?.engines?.node !== ">=24.0.0 <25") {
    violations.push("package.json engines.node must constrain Node.js 24.x");
  }
  if (rootManifest?.packageManager !== "pnpm@11.12.0") {
    violations.push("package.json packageManager must pin pnpm 11.12.0");
  }
  for (const [name, command] of Object.entries(rootManifest?.scripts ?? {})) {
    if (hasUnqualifiedPnpmToken(command)) {
      violations.push(`root script ${name} must invoke corepack pnpm`);
    }
  }
  if (playwrightConfig !== undefined && hasUnqualifiedPnpmToken(playwrightConfig)) {
    violations.push("playwright.config.ts web server must invoke corepack pnpm");
  }

  if (dockerfile !== undefined) {
    const images = [...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?$/gimu)].map(
      (match) => match[1] ?? "",
    );
    if (
      images.length === 0 ||
      images.some(
        (image) => image.toLowerCase() !== "scratch" && !/@sha256:[a-f0-9]{64}$/u.test(image),
      )
    ) {
      violations.push("Dockerfile base images must pin a sha256 digest");
    }
    if (!/^USER\s+[1-9][0-9]*$/mu.test(dockerfile)) {
      violations.push("Dockerfile must select a non-root numeric user");
    }
    if (!/^CMD\s+\[/mu.test(dockerfile)) {
      violations.push("Dockerfile CMD must use exec form");
    }
  }

  for (const target of REQUIRED_MAKE_TARGETS) {
    if (!makefile || !new RegExp(`^${target}:`, "mu").test(makefile)) {
      violations.push(`Makefile is missing required target ${target}`);
    }
  }
  if (
    !makefile ||
    !/^install:\s*\n\tcorepack pnpm install --frozen-lockfile\s*$/mu.test(makefile)
  ) {
    violations.push("Makefile install must use corepack pnpm install --frozen-lockfile");
  }
  if (!makefile || !/^setup:\s+install\s*$/mu.test(makefile)) {
    violations.push("Makefile setup must depend on install");
  }
  for (const packagePath of REQUIRED_WORKSPACES) {
    if (!workspace?.split(/\r?\n/u).some((line) => line.trim() === `- ${packagePath}`)) {
      violations.push(`pnpm-workspace.yaml is missing ${packagePath}`);
    }
  }

  const manifests = new Map<string, PackageManifest>();
  for (const packagePath of REQUIRED_WORKSPACES) {
    const manifest = await manifestAt(path.join(root, packagePath, "package.json"));
    if (manifest?.name) manifests.set(manifest.name, manifest);
  }

  for (const [label, manifest] of [
    ["package.json", rootManifest],
    ...[...manifests].map(([name, value]) => [name, value] as const),
  ] as const) {
    const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (DEFERRED_DEPENDENCIES.has(dependency)) {
        violations.push(`${label} uses deferred dependency ${dependency}`);
      }
    }
  }

  const graph = new Map<string, string[]>();
  for (const [name, manifest] of manifests) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const workspaceDependencies = Object.keys(dependencies).filter((item) => manifests.has(item));
    graph.set(name, workspaceDependencies);
    const allowedDependencies = ALLOWED_WORKSPACE_DEPENDENCIES[name] ?? [];
    const productionWorkspaceDependencies = Object.keys(manifest.dependencies ?? {}).filter(
      (item) => manifests.has(item),
    );
    for (const dependency of productionWorkspaceDependencies) {
      if (!allowedDependencies.includes(dependency)) {
        violations.push(`${name} must not depend on ${dependency}`);
      }
    }
    const developmentWorkspaceDependencies = Object.keys(manifest.devDependencies ?? {}).filter(
      (item) => manifests.has(item),
    );
    for (const dependency of developmentWorkspaceDependencies) {
      const isServerTestSupport =
        name === "@symphony/server" && dependency === "@symphony/test-support";
      if (!isServerTestSupport && !allowedDependencies.includes(dependency)) {
        violations.push(`${name} must not depend on ${dependency}`);
      }
    }
    if (name === "@symphony/domain") {
      for (const dependency of Object.keys(dependencies)) {
        if (FORBIDDEN_DOMAIN_DEPENDENCIES.includes(dependency)) {
          violations.push(`@symphony/domain has forbidden dependency ${dependency}`);
        }
      }
    }
    if (manifest.scripts?.build && name !== "@symphony/web") {
      const rootExport =
        typeof manifest.exports === "object" && manifest.exports !== null
          ? manifest.exports["."]
          : undefined;
      const productionExport =
        typeof rootExport === "object" && rootExport !== null && "default" in rootExport
          ? rootExport.default
          : undefined;
      if (productionExport !== "./dist/index.js") {
        violations.push(`${name} production export must resolve to ./dist/index.js`);
      }
    }
  }

  const cycle = findCycle(graph);
  if (cycle) violations.push(`workspace dependency cycle: ${cycle.join(" -> ")}`);

  const productionSchedulerPath = path.join(root, "apps/server/src/production-scheduler.ts");
  const productionScheduler = await optionalRead(productionSchedulerPath);
  if (productionScheduler !== undefined) {
    for (const primitive of productionRuntimePrimitives(productionScheduler)) {
      violations.push(`apps/server/src/production-scheduler.ts must not use ${primitive}`);
    }
  }

  const schedulerServicePath = path.join(root, "packages/orchestration/src/scheduler/service.ts");
  const schedulerService = await optionalRead(schedulerServicePath);
  if (schedulerService !== undefined) {
    for (const primitive of schedulerIntervalPrimitives(schedulerService)) {
      violations.push(`packages/orchestration/src/scheduler/service.ts must not use ${primitive}`);
    }
  }

  for (const file of await repositoryTextFiles(root)) {
    const source = await readFile(file, "utf8");
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/mu.test(source)) {
      violations.push(`${path.relative(root, file)} contains an unresolved conflict marker`);
    }
  }

  for (const file of await workflowFiles(root)) {
    const source = await readFile(file, "utf8");
    const relativeFile = path.relative(root, file);
    for (const match of source.matchAll(/\buses:\s*[^\s@]+@([^\s#]+)/gu)) {
      if (!/^[a-f0-9]{40}$/u.test(match[1] ?? "")) {
        violations.push(
          `${path.relative(root, file)} action references must use a full 40-character commit SHA`,
        );
      }
    }
    if (hasSingleQuotedNodeInterpolation(source)) {
      violations.push(`${relativeFile} contains an SC2016-prone interpolation in single-quoted JS`);
    }
    if (/^\s*sha256sum[^\n]*\*\.cdx\.json\b/mu.test(source)) {
      violations.push(`${relativeFile} contains an SC2035-prone checksum glob`);
    }
    violations.push(
      ...Array.from(
        source.matchAll(/^\s*!\s+(?:gh release view|docker buildx imagetools inspect)\b/gmu),
        () => `${relativeFile} contains an SC2251-prone standalone negation`,
      ),
    );
    if (path.basename(file) === "ci.yml") {
      const verifyJob = workflowJobSource(source, "verify");
      const publishJob = workflowJobSource(source, "publish");
      if (
        !verifyJob ||
        !/^\s*- run: make install\s*$/mu.test(verifyJob) ||
        !publishJob ||
        !/^\s*- run: make install\s*$/mu.test(publishJob)
      ) {
        violations.push("ci.yml verification and publication jobs must use make install");
      }
      if (!verifyJob || !/^\s*- run: make verify-fast\s*$/mu.test(verifyJob)) {
        violations.push("ci.yml verification job must use make verify-fast");
      }
    }
    if (path.basename(file) === "release.yml") {
      const exactImageReference = 'image_reference="$' + "{IMAGE}:$" + '{TAG}"';
      const exactManifestPath =
        'registry_manifest_path="/v2/$' + "{REPOSITORY}/manifests/$" + '{TAG}"';
      const lowerImageReference = '"$' + '{image_reference,,}"';
      const lowerManifestPath = '"$' + '{registry_manifest_path,,}"';
      if (
        !/gh api[\s\S]*--include/u.test(source) ||
        !/release_status[\s\S]*!= "404"/u.test(source) ||
        !source.includes("release.preflight.github.unavailable")
      ) {
        violations.push("release.yml GitHub release preflight must fail closed except on HTTP 404");
      }
      if (
        !source.includes("image_probe_error") ||
        !source.includes(exactImageReference) ||
        !source.includes(exactManifestPath) ||
        !source.includes(lowerImageReference) ||
        !source.includes(lowerManifestPath) ||
        !source.includes("(404|manifest[[:space:]]unknown|not[[:space:]]found)") ||
        !source.includes("release.preflight.image.unavailable")
      ) {
        violations.push("release.yml image-tag preflight must fail closed except on not-found");
      }
      const draftRelease = source.indexOf("gh release create");
      const finalRelease = source.indexOf('gh release edit "$TAG" --draft=false');
      const imagePromotion = source.indexOf("docker buildx imagetools create");
      if (
        draftRelease < 0 ||
        finalRelease < draftRelease ||
        imagePromotion < finalRelease ||
        !source.slice(draftRelease, finalRelease).includes("--draft")
      ) {
        violations.push("release.yml must finalize release before semantic image promotion");
      }
      if (
        !source.includes("trap cleanup_release EXIT") ||
        !source.includes('gh release delete "$TAG" --yes')
      ) {
        violations.push("release.yml must clean up release when image promotion fails");
      }
      const digestVerification = source.indexOf('[[ "$promoted_digest" != "$source_digest" ]]');
      const transactionComplete = source.indexOf("cleanup_required=false");
      if (
        digestVerification < imagePromotion ||
        transactionComplete < digestVerification ||
        !source.includes("release.cleanup.image_tag_manual_required")
      ) {
        violations.push("release.yml must verify promoted digest before completing transaction");
      }
      const imageAttemptArmed = source.indexOf("image_tag_attempted=true");
      if (
        imageAttemptArmed < 0 ||
        imageAttemptArmed > imagePromotion ||
        !source.includes('[[ "$image_tag_attempted" == "true" ]]')
      ) {
        violations.push("release.yml must arm uncertain image cleanup before promotion attempt");
      }
    }
  }

  return violations;
}

type ProductionRuntimePrimitive =
  | "Date.now"
  | "Math.random"
  | "node:crypto"
  | "randomUUID"
  | "zero-argument new Date";
type SchedulerIntervalPrimitive = "clearInterval" | "setInterval";

function productionRuntimePrimitives(source: string): readonly ProductionRuntimePrimitive[] {
  const found = new Set<ProductionRuntimePrimitive>();
  const scanned = sanitizeTypeScript(source);
  const code = scanned.code;
  if (scanned.modules.includes("node:crypto")) found.add("node:crypto");
  if (/\brandomUUID\b/u.test(code)) found.add("randomUUID");

  const dateAliases = runtimeObjectAliases(code, "Date");
  const mathAliases = runtimeObjectAliases(code, "Math");
  const dateNames = identifierAlternation(dateAliases);
  const mathNames = identifierAlternation(mathAliases);
  if (
    new RegExp(`\\bnew\\s+(?:(?:globalThis)\\s*\\.\\s*)?(?:${dateNames})\\s*\\(\\s*\\)`, "u").test(
      code,
    )
  ) {
    found.add("zero-argument new Date");
  }
  if (
    new RegExp(
      `(?:(?:globalThis)\\s*\\.\\s*)?(?:${dateNames})\\s*\\.\\s*now\\b|\\{[^}]*\\bnow\\b[^}]*\\}\\s*=\\s*(?:${dateNames})\\b`,
      "u",
    ).test(code)
  ) {
    found.add("Date.now");
  }
  if (
    new RegExp(
      `(?:(?:globalThis)\\s*\\.\\s*)?(?:${mathNames})\\s*\\.\\s*random\\b|\\{[^}]*\\brandom\\b[^}]*\\}\\s*=\\s*(?:${mathNames})\\b`,
      "u",
    ).test(code)
  ) {
    found.add("Math.random");
  }
  return [...found];
}

function schedulerIntervalPrimitives(source: string): readonly SchedulerIntervalPrimitive[] {
  const found = new Set<SchedulerIntervalPrimitive>();
  const scanned = sanitizeTypeScript(source);
  for (const primitive of ["clearInterval", "setInterval"] as const) {
    const direct = new RegExp(`(?:(?:globalThis)\\s*\\.\\s*)?\\b${primitive}\\s*\\(`, "u").test(
      scanned.code,
    );
    const alias = new RegExp(
      `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*(?:(?:globalThis)\\s*\\.\\s*)?${primitive}\\b`,
      "u",
    ).test(scanned.code);
    const imported =
      scanned.modules.some(
        (module) => module === "node:timers" || module === "node:timers/promises",
      ) && new RegExp(`\\b${primitive}\\b`, "u").test(scanned.code);
    if (direct || alias || imported) found.add(primitive);
  }
  return [...found];
}

function runtimeObjectAliases(source: string, globalName: "Date" | "Math"): Set<string> {
  const aliases = new Set<string>([globalName]);
  let changed = true;
  while (changed) {
    changed = false;
    const known = identifierAlternation(aliases);
    const pattern = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:(?:globalThis)\\s*\\.\\s*)?(?:${known})\\b`,
      "gu",
    );
    for (const match of source.matchAll(pattern)) {
      const alias = match[1];
      if (alias && !aliases.has(alias)) {
        aliases.add(alias);
        changed = true;
      }
    }
  }
  return aliases;
}

function identifierAlternation(identifiers: ReadonlySet<string>): string {
  return [...identifiers].map((value) => value.replaceAll("$", "\\$")).join("|");
}

function sanitizeTypeScript(source: string): { code: string; modules: string[] } {
  const code = [...source];
  const modules: string[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      blank(code, index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      const end = closing < 0 ? source.length : closing + 2;
      blank(code, index, end);
      index = end;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      const start = index;
      let value = "";
      index += 1;
      while (index < source.length) {
        const character = source[index];
        if (character === "\\") {
          index += 2;
          continue;
        }
        if (character === quote) {
          index += 1;
          break;
        }
        value += character;
        index += 1;
      }
      const prefix = code.slice(0, start).join("");
      if (/(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/u.test(prefix)) {
        modules.push(value);
      }
      blank(code, start, index);
      continue;
    }
    index += 1;
  }
  return { code: code.join(""), modules };
}

function blank(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
  }
}

async function main(): Promise<void> {
  const violations = await validateRepository(process.cwd());
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${violation}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
