import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { validateStagedSnapshot } from "./check-staged.js";

const execute = promisify(execFile);

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-staged-"));
  await execute("git", ["init", "--quiet"], { cwd: root });
  return root;
}

describe("staged snapshot policy", () => {
  it("accepts a small clean text file", async () => {
    const root = await repository();
    await writeFile(path.join(root, "clean.ts"), "export const clean = true;\n");
    await execute("git", ["add", "clean.ts"], { cwd: root });
    await expect(validateStagedSnapshot(root)).resolves.toEqual([]);
  });

  it("rejects whitespace errors, binaries, and oversized blobs", async () => {
    const root = await repository();
    await writeFile(
      path.join(root, "whitespace.txt"),
      "<<<<<<< ours\ntrailing space \n=======\nother\n>>>>>>> theirs\n",
    );
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_048_577));
    await execute("git", ["add", "."], { cwd: root });

    const errors = await validateStagedSnapshot(root);
    expect(errors.join("\n")).toContain("trailing whitespace");
    expect(errors.join("\n")).toContain("leftover conflict marker");
    expect(errors).toContain("binary.bin: binary files require explicit review");
    expect(errors).toContain("large.txt: staged blob exceeds 1048576 bytes");
  });
});
