import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const GITLEAKS_VERSION = "8.30.1";

const ARTIFACTS = {
  "darwin:arm64": {
    archive: "gitleaks_8.30.1_darwin_arm64.tar.gz",
    sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  },
  "darwin:x64": {
    archive: "gitleaks_8.30.1_darwin_x64.tar.gz",
    sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  },
  "linux:arm64": {
    archive: "gitleaks_8.30.1_linux_arm64.tar.gz",
    sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  },
  "linux:x64": {
    archive: "gitleaks_8.30.1_linux_x64.tar.gz",
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  },
} as const;

export function selectGitleaksArtifact(platform: string, architecture: string) {
  const artifact = ARTIFACTS[`${platform}:${architecture}` as keyof typeof ARTIFACTS];
  if (!artifact) throw new Error(`gitleaks.unsupported_host:${platform}:${architecture}`);
  return artifact;
}

export async function installGitleaks(root = process.cwd()): Promise<string> {
  const destinationDirectory = path.join(root, ".tools", "gitleaks", GITLEAKS_VERSION);
  const destination = path.join(destinationDirectory, "gitleaks");
  try {
    const { stdout } = await execute(destination, ["version"]);
    if (stdout.includes(GITLEAKS_VERSION)) return destination;
  } catch {
    // Install or replace a missing or incompatible local tool.
  }

  const artifact = selectGitleaksArtifact(process.platform, process.arch);
  await mkdir(path.join(root, ".tools"), { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".tools", "gitleaks-install-"));
  try {
    const archive = path.join(temporary, artifact.archive);
    const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${artifact.archive}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`gitleaks.download_failed:${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const actual = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    if (actual !== artifact.sha256) throw new Error("gitleaks.checksum_mismatch");
    await execute("tar", ["-xzf", archive, "-C", temporary, "gitleaks"]);
    await mkdir(destinationDirectory, { recursive: true });
    await copyFile(path.join(temporary, "gitleaks"), destination);
    await chmod(destination, 0o755);
    return destination;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const installed = await installGitleaks();
  process.stdout.write(`Installed Gitleaks ${GITLEAKS_VERSION} at ${installed}\n`);
}
