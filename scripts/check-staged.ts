import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_STAGED_BLOB_BYTES = 1_048_576;

export async function validateStagedSnapshot(root = process.cwd()): Promise<string[]> {
  const errors: string[] = [];
  try {
    await execute("git", ["diff", "--cached", "--check"], { cwd: root });
  } catch (error) {
    errors.push((error as { stdout?: string }).stdout?.trim() || "staged whitespace check failed");
  }

  const { stdout } = await execute(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    { cwd: root, encoding: "buffer" },
  );
  const files = stdout
    .toString("utf8")
    .split("\0")
    .filter((file) => file.length > 0);
  for (const file of files) {
    const size = Number(
      (await execute("git", ["cat-file", "-s", `:${file}`], { cwd: root })).stdout,
    );
    if (!Number.isSafeInteger(size) || size > MAX_STAGED_BLOB_BYTES) {
      errors.push(`${file}: staged blob exceeds ${MAX_STAGED_BLOB_BYTES} bytes`);
    }
    const numstat = (
      await execute("git", ["diff", "--cached", "--numstat", "--", file], {
        cwd: root,
      })
    ).stdout;
    if (numstat.startsWith("-\t-\t")) errors.push(`${file}: binary files require explicit review`);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = await validateStagedSnapshot();
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
