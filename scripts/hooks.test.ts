import { readFile, stat } from "node:fs/promises";
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
    expect(makefile).toMatch(
      /setup:\n\tcorepack pnpm install --frozen-lockfile\n\tnode scripts\/install-gitleaks\.ts\n\tnode --import \.\/scripts\/typescript-source-loader\.mjs scripts\/verify-gitleaks\.ts\n\tcorepack pnpm exec husky/u,
    );
  });
});
