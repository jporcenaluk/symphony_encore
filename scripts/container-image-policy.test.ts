import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production container attack surface", () => {
  it("removes build-only JavaScript package managers from the runtime stage", async () => {
    const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile"), "utf8");
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

    expect(runtimeStage).toContain("rm -rf /usr/local/lib/node_modules/npm");
    expect(runtimeStage).toContain("/usr/local/lib/node_modules/corepack");
    expect(runtimeStage).toContain("/usr/local/bin/npm");
    expect(runtimeStage).toContain("/usr/local/bin/npx");
    expect(runtimeStage).toContain("/usr/local/bin/corepack");
    expect(runtimeStage).toContain("/usr/local/bin/pnpm");
    expect(runtimeStage).toContain("/usr/local/bin/yarn");
  });
});
