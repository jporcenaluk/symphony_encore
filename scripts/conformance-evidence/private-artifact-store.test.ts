import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closePrivateArtifactStore,
  openPrivateArtifactStore,
  publishPrivateArtifact,
} from "./private-artifact-store.js";

const directories: string[] = [];

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-artifact-store-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("private artifact store", () => {
  it("publishes exact bounded bytes with private metadata and a content digest", async () => {
    const directory = await privateDirectory();
    const store = await openPrivateArtifactStore(directory);
    const bytes = Buffer.from('{"complete":false}\n', "utf8");
    try {
      await expect(publishPrivateArtifact(store, "evidence.json", bytes)).resolves.toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    } finally {
      await closePrivateArtifactStore(store);
    }
    const target = path.join(directory, "evidence.json");
    expect(await readFile(target)).toEqual(bytes);
    const metadata = await stat(target);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
  });

  it.each([
    "write",
    "sync",
    "rename",
  ] as const)("leaves the old artifact unchanged and cleans the temp after injected %s failure", async (failure) => {
    const directory = await privateDirectory();
    const target = path.join(directory, "evidence.json");
    await writeFile(target, "old\n", { encoding: "utf8", mode: 0o600 });
    const store = await openPrivateArtifactStore(directory);
    try {
      await expect(
        publishPrivateArtifact(store, "evidence.json", Buffer.from("new\n"), {
          ...(failure === "write"
            ? { beforeWrite: () => Promise.reject(new Error("injected write")) }
            : {}),
          ...(failure === "sync"
            ? {
                beforeSync: (stage) =>
                  stage === "file" ? Promise.reject(new Error("injected sync")) : Promise.resolve(),
              }
            : {}),
          ...(failure === "rename"
            ? { beforeRename: () => Promise.reject(new Error("injected rename")) }
            : {}),
        }),
      ).rejects.toThrow("evidence.atomic_write_failed");
    } finally {
      await closePrivateArtifactStore(store);
    }
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects stale symlink, linked, and permissive artifacts", async () => {
    for (const kind of ["symlink", "linked", "permissive"] as const) {
      const directory = await privateDirectory();
      const target = path.join(directory, "evidence.json");
      const outside = path.join(directory, "outside.json");
      await writeFile(outside, "outside\n", { encoding: "utf8", mode: 0o600 });
      if (kind === "symlink") await symlink(outside, target);
      if (kind === "linked") await link(outside, target);
      if (kind === "permissive") {
        await writeFile(target, "old\n", { encoding: "utf8", mode: 0o600 });
        await chmod(target, 0o644);
      }
      const store = await openPrivateArtifactStore(directory);
      try {
        await expect(
          publishPrivateArtifact(store, "evidence.json", Buffer.from("new\n")),
        ).rejects.toThrow("evidence.private_artifact_invalid");
      } finally {
        await closePrivateArtifactStore(store);
      }
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    }
  });

  it("rejects permissive and symlinked private directories", async () => {
    const permissive = await privateDirectory();
    await chmod(permissive, 0o755);
    await expect(openPrivateArtifactStore(permissive)).rejects.toThrow(
      "evidence.private_directory_invalid",
    );

    const target = await privateDirectory();
    const link = `${target}.link`;
    directories.push(link);
    await symlink(target, link, "dir");
    await expect(openPrivateArtifactStore(link)).rejects.toThrow(
      "evidence.private_directory_invalid",
    );
  });

  it("fails closed when the accepted directory path is replaced", async () => {
    const directory = await privateDirectory();
    const moved = `${directory}.moved`;
    directories.push(moved);
    const store = await openPrivateArtifactStore(directory);
    await rename(directory, moved);
    await mkdir(directory, { mode: 0o700 });
    try {
      await expect(
        publishPrivateArtifact(store, "evidence.json", Buffer.from("new\n")),
      ).rejects.toThrow("evidence.private_directory_changed");
    } finally {
      await closePrivateArtifactStore(store);
    }
  });

  it("rejects empty names, empty bytes, traversal, and oversized artifacts without writing", async () => {
    const directory = await privateDirectory();
    const store = await openPrivateArtifactStore(directory);
    try {
      await expect(publishPrivateArtifact(store, "", Buffer.from("x"))).rejects.toThrow(
        "evidence.private_artifact_invalid",
      );
      await expect(publishPrivateArtifact(store, "evidence.json", Buffer.alloc(0))).rejects.toThrow(
        "evidence.private_artifact_invalid",
      );
      await expect(publishPrivateArtifact(store, "../outside", Buffer.from("x"))).rejects.toThrow(
        "evidence.private_artifact_invalid",
      );
      await expect(
        publishPrivateArtifact(store, "evidence.json", Buffer.alloc(4 * 1024 * 1024 + 1)),
      ).rejects.toThrow("evidence.private_artifact_invalid");
    } finally {
      await closePrivateArtifactStore(store);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("accepts an artifact exactly at the configured maximum", async () => {
    const directory = await privateDirectory();
    const store = await openPrivateArtifactStore(directory);
    const maximum = Buffer.alloc(4 * 1024 * 1024, 0x61);
    try {
      await expect(publishPrivateArtifact(store, "maximum.bin", maximum)).resolves.toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
    } finally {
      await closePrivateArtifactStore(store);
    }
    expect((await stat(path.join(directory, "maximum.bin"))).size).toBe(maximum.length);
  });
});
