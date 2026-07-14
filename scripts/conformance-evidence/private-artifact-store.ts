import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const OPEN_STORES = new WeakSet<object>();

type FileHandle = Awaited<ReturnType<typeof open>>;

export interface PrivateArtifactStore {
  readonly device: number;
  readonly handle: FileHandle;
  readonly inode: number;
  readonly path: string;
}

export interface ArtifactStoreTestHooks {
  readonly beforeRename?: () => void | Promise<void>;
  readonly beforeSync?: (stage: "directory" | "file") => void | Promise<void>;
  readonly beforeWrite?: () => void | Promise<void>;
}

function owns(metadata: { readonly uid: number }): boolean {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function validPrivateFile(metadata: Stats, maxSize = MAX_ARTIFACT_BYTES): boolean {
  return (
    metadata.isFile() &&
    owns(metadata) &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o777) === 0o600 &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    metadata.size <= maxSize
  );
}

async function assertDirectoryIdentity(store: PrivateArtifactStore): Promise<void> {
  if (!OPEN_STORES.has(store)) throw new Error("evidence.private_directory_invalid");
  try {
    const held = await store.handle.stat({ bigint: false });
    const current = await lstat(store.path);
    if (
      !held.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !owns(held) ||
      !owns(current) ||
      (held.mode & 0o777) !== 0o700 ||
      (current.mode & 0o777) !== 0o700 ||
      held.dev !== store.device ||
      held.ino !== store.inode ||
      current.dev !== store.device ||
      current.ino !== store.inode
    ) {
      throw new Error("changed");
    }
  } catch {
    throw new Error("evidence.private_directory_changed");
  }
}

async function validateExistingTarget(target: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat({ bigint: false });
    const pathMetadata = await lstat(target);
    if (
      !validPrivateFile(metadata) ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino
    ) {
      throw new Error("invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("evidence.private_artifact_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function openPrivateArtifactStore(
  privateDirectory: string,
): Promise<PrivateArtifactStore> {
  const resolved = path.resolve(privateDirectory);
  let handle: FileHandle | undefined;
  try {
    const initial = await lstat(resolved);
    const canonical = await realpath(resolved);
    if (
      initial.isSymbolicLink() ||
      !initial.isDirectory() ||
      !owns(initial) ||
      (initial.mode & 0o777) !== 0o700
    ) {
      throw new Error("invalid");
    }
    handle = await open(
      canonical,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const held = await handle.stat({ bigint: false });
    const current = await lstat(canonical);
    if (
      !held.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !owns(held) ||
      !owns(current) ||
      (held.mode & 0o777) !== 0o700 ||
      (current.mode & 0o777) !== 0o700 ||
      held.dev !== initial.dev ||
      held.ino !== initial.ino ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw new Error("invalid");
    }
    const store = { device: held.dev, handle, inode: held.ino, path: canonical };
    OPEN_STORES.add(store);
    handle = undefined;
    return store;
  } catch {
    await handle?.close().catch(() => undefined);
    throw new Error("evidence.private_directory_invalid");
  }
}

export async function closePrivateArtifactStore(store: PrivateArtifactStore): Promise<void> {
  OPEN_STORES.delete(store);
  await store.handle.close();
}

export async function publishPrivateArtifact(
  store: PrivateArtifactStore,
  artifactName: string,
  serialized: Buffer,
  hooks: ArtifactStoreTestHooks = {},
): Promise<`sha256:${string}`> {
  if (
    artifactName.length === 0 ||
    path.basename(artifactName) !== artifactName ||
    serialized.length === 0 ||
    serialized.length > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("evidence.private_artifact_invalid");
  }
  await assertDirectoryIdentity(store);
  const target = path.join(store.path, artifactName);
  await validateExistingTarget(target);
  const temporary = path.join(store.path, `.${artifactName}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await hooks.beforeWrite?.();
    const write = await handle.write(serialized, 0, serialized.length, 0);
    if (write.bytesWritten !== serialized.length) throw new Error("short write");
    await hooks.beforeSync?.("file");
    await handle.sync();
    const beforeRename = await handle.stat({ bigint: false });
    if (!validPrivateFile(beforeRename) || beforeRename.size !== serialized.length) {
      throw new Error("invalid temporary artifact");
    }

    await assertDirectoryIdentity(store);
    await hooks.beforeRename?.();
    await rename(temporary, target);
    renamed = true;

    const afterRename = await handle.stat({ bigint: false });
    const finalPath = await lstat(target);
    if (
      !validPrivateFile(afterRename) ||
      afterRename.size !== serialized.length ||
      afterRename.dev !== beforeRename.dev ||
      afterRename.ino !== beforeRename.ino ||
      finalPath.isSymbolicLink() ||
      finalPath.dev !== afterRename.dev ||
      finalPath.ino !== afterRename.ino
    ) {
      throw new Error("invalid final artifact");
    }
    const observed = Buffer.alloc(serialized.length);
    const read = await handle.read(observed, 0, observed.length, 0);
    if (read.bytesRead !== serialized.length || !observed.equals(serialized)) {
      throw new Error("artifact content drift");
    }
    const finalValidation = await handle.stat({ bigint: false });
    const finalPathValidation = await lstat(target);
    if (
      !validPrivateFile(finalValidation) ||
      finalValidation.size !== serialized.length ||
      finalValidation.dev !== afterRename.dev ||
      finalValidation.ino !== afterRename.ino ||
      finalPathValidation.isSymbolicLink() ||
      finalPathValidation.dev !== finalValidation.dev ||
      finalPathValidation.ino !== finalValidation.ino
    ) {
      throw new Error("artifact changed after read");
    }
    const artifactDigest = `sha256:${createHash("sha256").update(observed).digest("hex")}` as const;
    await hooks.beforeSync?.("directory");
    await store.handle.sync();
    await assertDirectoryIdentity(store);
    return artifactDigest;
  } catch (error) {
    if ((error as Error).message === "evidence.private_directory_changed") throw error;
    if ((error as Error).message === "evidence.private_artifact_invalid") throw error;
    throw new Error("evidence.atomic_write_failed");
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
