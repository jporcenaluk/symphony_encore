import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repository-owned Git hooks", () => {
  it("runs staged format, policy, and exact pinned secret checks", async () => {
    const root = process.cwd();
    const preCommit = await readFile(path.join(root, ".husky", "pre-commit"), "utf8");
    expect(preCommit).toContain("pnpm exec lint-staged");
    expect(preCommit).toContain("node scripts/check-staged.ts");
    expect(preCommit).toContain(
      ".tools/gitleaks/8.30.1/gitleaks git --pre-commit --redact --staged --verbose",
    );
    expect((await stat(path.join(root, ".husky", "pre-commit"))).mode & 0o111).not.toBe(0);
  });

  it("validates commit subjects and installs hooks through make setup", async () => {
    const root = process.cwd();
    const commitMessage = await readFile(path.join(root, ".husky", "commit-msg"), "utf8");
    const makefile = await readFile(path.join(root, "Makefile"), "utf8");
    expect(commitMessage).toContain('node scripts/validate-commit-message.ts "$1"');
    expect(makefile).toMatch(/install:\n\tcorepack pnpm install --frozen-lockfile/u);
    expect(makefile).toMatch(
      /setup: install\n\tnode scripts\/install-gitleaks\.ts\n\tnode --import \.\/scripts\/typescript-source-loader\.mjs scripts\/verify-gitleaks\.ts\n\tcorepack pnpm exec husky/u,
    );
  });

  it("runs a nested Corepack pnpm script without a pnpm shim on PATH", async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      packageManager: string;
      scripts: { build: string };
    };
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "symphony-clean-path-"));
    const bin = path.join(temporaryRoot, "bin");
    const project = path.join(temporaryRoot, "project");
    await Promise.all([mkdir(bin), mkdir(project)]);

    try {
      await Promise.all([
        symlink(process.execPath, path.join(bin, "node")),
        symlink(
          await realpath(path.join(path.dirname(process.execPath), "corepack")),
          path.join(bin, "corepack"),
        ),
        symlink(await realpath("/bin/sh"), path.join(bin, "sh")),
      ]);
      await writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "clean-path-corepack-regression",
          packageManager: manifest.packageManager,
          private: true,
          scripts: { nested: manifest.scripts.build },
        }),
        "utf8",
      );

      await expect(access(path.join(bin, "pnpm"))).rejects.toMatchObject({ code: "ENOENT" });
      const result = spawnSync(path.join(bin, "corepack"), ["pnpm", "run", "nested"], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });

      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
