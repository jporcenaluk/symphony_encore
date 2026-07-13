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

export async function validateRepository(root: string): Promise<string[]> {
  const violations: string[] = [];
  const rootManifest = await manifestAt(path.join(root, "package.json"));
  const nodeVersion = (await optionalRead(path.join(root, ".node-version")))?.trim();
  const makefile = await optionalRead(path.join(root, "Makefile"));
  const dockerfile = await optionalRead(path.join(root, "Dockerfile"));
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
    for (const dependency of workspaceDependencies) {
      if (!allowedDependencies.includes(dependency)) {
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

  for (const file of await repositoryTextFiles(root)) {
    const source = await readFile(file, "utf8");
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/mu.test(source)) {
      violations.push(`${path.relative(root, file)} contains an unresolved conflict marker`);
    }
  }

  for (const file of await workflowFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\buses:\s*[^\s@]+@([^\s#]+)/gu)) {
      if (!/^[a-f0-9]{40}$/u.test(match[1] ?? "")) {
        violations.push(
          `${path.relative(root, file)} action references must use a full 40-character commit SHA`,
        );
      }
    }
  }

  return violations;
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
