import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONVENTIONAL_COMMIT_PATTERN =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|test)(\([a-z0-9._-]+\))?!?: .+$/u;

export function isValidCommitMessage(message: string): boolean {
  const subject = message.split(/\r?\n/u)[0] ?? "";
  return CONVENTIONAL_COMMIT_PATTERN.test(subject);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file || !isValidCommitMessage(await readFile(file, "utf8"))) {
    process.stderr.write("Commit subject must use the repository Conventional Commit format.\n");
    process.exitCode = 1;
  }
}
