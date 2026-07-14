import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./conformance-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conformance-evidence.js")>()),
  produceTrustedEvidence: vi.fn(async () => {
    throw new Error("simulated producer failure");
  }),
}));

const { runConformanceCommand } = await import("./conformance-command.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("conformance command producer failure", () => {
  it("publishes a rejected report when trusted evidence production throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-command-producer-failure-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "0.0.0" })}\n`,
      "utf8",
    );
    await mkdir(path.join(root, "artifacts"), { mode: 0o700 });

    const previous = process.cwd();
    process.chdir(root);
    try {
      const result = await runConformanceCommand();
      expect(result.exitCode).toBe(1);
      expect(result.report.results.core_evidence).toMatchObject({
        diagnostics: ["conformance.evidence.unavailable", "conformance.evidence.production_failed"],
        status: "rejected",
        trusted: false,
      });
      expect(JSON.parse(await readFile(result.reportPath, "utf8"))).toEqual(result.report);
    } finally {
      process.chdir(previous);
    }
  });
});
