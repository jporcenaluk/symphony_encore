import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GITLEAKS_VERSION } from "./install-gitleaks.js";

const execute = promisify(execFile);
const binary = path.join(process.cwd(), ".tools", "gitleaks", GITLEAKS_VERSION, "gitleaks");
const root = await mkdtemp(path.join(tmpdir(), "symphony-gitleaks-"));

try {
  await execute("git", ["init", "--quiet"], { cwd: root });
  const secret = `ghp_${randomBytes(27).toString("base64url")}`;
  await writeFile(path.join(root, "candidate.txt"), `token=${secret}\n`);
  await execute("git", ["add", "candidate.txt"], { cwd: root });
  try {
    await execute(binary, ["git", "--pre-commit", "--redact", "--staged", "--verbose"], {
      cwd: root,
    });
    throw new Error("gitleaks.synthetic_secret_not_detected");
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
    if (output.includes(secret)) throw new Error("gitleaks.output_not_redacted");
    if (!/leak/iu.test(output)) throw error;
  }

  await writeFile(path.join(root, "candidate.txt"), "token=synthetic-reference\n");
  await execute("git", ["add", "candidate.txt"], { cwd: root });
  await execute(binary, ["git", "--pre-commit", "--redact", "--staged", "--verbose"], {
    cwd: root,
  });
  process.stdout.write(`Gitleaks ${GITLEAKS_VERSION} staged smoke passed\n`);
} finally {
  await rm(root, { force: true, recursive: true });
}
