import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCoreEvidenceBundle } from "../packages/contracts/src/index.ts";

const { captureRepositorySnapshotMock } = vi.hoisted(() => ({
  captureRepositorySnapshotMock: vi.fn(),
}));

vi.mock("./conformance-evidence/repository-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conformance-evidence/repository-snapshot.js")>()),
  captureRepositorySnapshot: captureRepositorySnapshotMock,
}));

import {
  isTrustedEvidenceRun,
  produceTrustedEvidence,
  type TrustedEvidenceRun,
} from "./conformance-evidence.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const tree = "1111111111111111111111111111111111111111";
const directories: string[] = [];

function cleanSnapshot(overrides = {}) {
  return {
    diagnostics: [],
    repositoryRoot: process.cwd(),
    revision,
    sourceDateEpoch: 1767225600,
    tree,
    ...overrides,
  };
}

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-evidence-"));
  directories.push(directory);
  return directory;
}

beforeEach(() => {
  captureRepositorySnapshotMock.mockReset();
  captureRepositorySnapshotMock.mockResolvedValue(cleanSnapshot());
});

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("unmapped trusted evidence facade", () => {
  it("returns a frozen same-invocation value with all 35 cases incomplete and unmapped", async () => {
    const directory = await privateDirectory();
    const run = await produceTrustedEvidence(directory);

    expect(run.complete).toBe(false);
    expect(run.suite_results).toHaveLength(35);
    expect(run.suite_results.every((result) => result.mapping === "unmapped")).toBe(true);
    expect(run.suite_results.every((result) => !("execution" in result))).toBe(true);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.suite_results)).toBe(true);
    expect(isTrustedEvidenceRun(run)).toBe(true);
    expect(isTrustedEvidenceRun({ ...run })).toBe(false);
    expect(isTrustedEvidenceRun(JSON.parse(JSON.stringify(run)))).toBe(false);
    expect(validateCoreEvidenceBundle(run).ok).toBe(false);

    const persisted = JSON.parse(
      await readFile(path.join(directory, "core-evidence-run.json"), "utf8"),
    ) as TrustedEvidenceRun;
    expect(persisted).toEqual(JSON.parse(JSON.stringify(run)));
    expect(isTrustedEvidenceRun(persisted)).toBe(false);
  });

  it("records repository diagnostics and never upgrades an unmapped run", async () => {
    captureRepositorySnapshotMock.mockResolvedValue({
      diagnostics: ["evidence.repository.dirty"],
      repositoryRoot: null,
      revision: null,
      sourceDateEpoch: null,
      tree: null,
    });
    const run = await produceTrustedEvidence(await privateDirectory());
    expect(run.diagnostics).toEqual(["evidence.repository.dirty"]);
    expect(run.revision).toBeNull();
    expect(run.complete).toBe(false);
    expect(captureRepositorySnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("fails the snapshot if exact HEAD/tree metadata changes between observations", async () => {
    captureRepositorySnapshotMock
      .mockResolvedValueOnce(cleanSnapshot())
      .mockResolvedValueOnce(cleanSnapshot({ tree: "2222222222222222222222222222222222222222" }));
    const run = await produceTrustedEvidence(await privateDirectory());
    expect(run.diagnostics).toEqual(["evidence.repository.changed_during_run"]);
    expect(run.revision).toBeNull();
  });

  it("produces stable payload digests and changes them when repository metadata changes", async () => {
    const first = await produceTrustedEvidence(await privateDirectory());
    captureRepositorySnapshotMock.mockResolvedValue(
      cleanSnapshot({
        revision: "2222222222222222222222222222222222222222",
        tree: "3333333333333333333333333333333333333333",
      }),
    );
    const second = await produceTrustedEvidence(await privateDirectory());
    expect(first.artifact_digest).not.toBe(second.artifact_digest);
  });
});
