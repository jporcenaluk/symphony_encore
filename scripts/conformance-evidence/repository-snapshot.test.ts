import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureRepositorySnapshot,
  type GitProbeResult,
  type RepositoryProbe,
  type RepositorySnapshot,
  repositorySnapshotFromProbe,
  snapshotsMatch,
} from "./repository-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);
const revision = "0123456789abcdef0123456789abcdef01234567";
const tree = "1111111111111111111111111111111111111111";
const ok = (stdout: string): GitProbeResult => ({ ok: true, stdout });

function probe(overrides: Partial<RepositoryProbe> = {}): RepositoryProbe {
  return {
    head: ok(`${revision}\n`),
    root: ok(`${process.cwd()}\n`),
    status: ok(""),
    timestamp: ok("1767225600\n"),
    tree: ok(`${tree}\n`),
    ...overrides,
  };
}

function snapshot(overrides: Partial<RepositoryProbe> = {}, sourceDateEpoch?: string) {
  return repositorySnapshotFromProbe(probe(overrides), {
    cwd: process.cwd(),
    ...(sourceDateEpoch === undefined ? {} : { sourceDateEpoch }),
  });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.stubEnv("GITHUB_SHA", revision);
});

afterEach(() => vi.unstubAllEnvs());

describe("repository snapshot validation", () => {
  it("accepts an exact clean HEAD/tree snapshot", () => {
    expect(snapshot()).toEqual({
      diagnostics: [],
      repositoryRoot: path.resolve(process.cwd()),
      revision,
      sourceDateEpoch: 1767225600,
      tree,
    });
  });

  it.each([
    ["dirty status", { status: ok(" M changed.ts\n") }, "evidence.repository.dirty"],
    ["wrong root", { root: ok("/other/repo\n") }, "evidence.repository.root_invalid"],
    ["invalid revision", { head: ok("not-a-revision\n") }, "evidence.repository.revision_invalid"],
    ["invalid tree", { tree: ok("not-a-tree\n") }, "evidence.repository.tree_invalid"],
    ["invalid timestamp", { timestamp: ok("-1\n") }, "evidence.repository.head_timestamp_invalid"],
  ])("rejects %s", (_label, overrides, diagnostic) => {
    expect(snapshot(overrides)).toMatchObject({ diagnostics: [diagnostic], revision: null });
  });

  it("preserves fixed-command failure metadata without leaking stderr", () => {
    expect(
      snapshot({ head: { diagnostic: "evidence.git.command_failed", ok: false } }),
    ).toMatchObject({
      diagnostics: ["evidence.repository.revision_invalid", "evidence.git.command_failed"],
    });
  });

  it.each([
    "-1",
    "01",
    "1.5",
    "9007199254740992",
  ])("rejects invalid SOURCE_DATE_EPOCH %s", (sourceDateEpoch) => {
    expect(snapshot({}, sourceDateEpoch)).toMatchObject({
      diagnostics: ["evidence.repository.source_date_epoch_invalid"],
    });
  });

  it("rejects mismatched or malformed GitHub revisions", () => {
    expect(
      repositorySnapshotFromProbe(probe(), {
        cwd: process.cwd(),
        githubSha: "2222222222222222222222222222222222222222",
      }),
    ).toMatchObject({ diagnostics: ["evidence.repository.github_sha_mismatch"] });
    expect(
      repositorySnapshotFromProbe(probe(), { cwd: process.cwd(), githubSha: "invalid" }),
    ).toMatchObject({ diagnostics: ["evidence.repository.github_sha_mismatch"] });
  });

  it.each([
    ["root", { repositoryRoot: "/different/root" }],
    ["revision", { revision: "2222222222222222222222222222222222222222" }],
    ["tree", { tree: "2222222222222222222222222222222222222222" }],
    ["epoch", { sourceDateEpoch: 1767225601 }],
  ])("rejects snapshots whose %s changes", (_label, change) => {
    const before = snapshot();
    expect(snapshotsMatch(before, { ...before, ...change })).toBe(false);
  });

  it("matches only exact clean snapshots and rejects diagnostics on either side", () => {
    const clean = snapshot();
    const diagnostic: RepositorySnapshot = {
      diagnostics: ["evidence.repository.dirty"],
      repositoryRoot: null,
      revision: null,
      sourceDateEpoch: null,
      tree: null,
    };
    expect(snapshotsMatch(clean, clean)).toBe(true);
    expect(snapshotsMatch(diagnostic, clean)).toBe(false);
    expect(snapshotsMatch(clean, diagnostic)).toBe(false);
  });

  it("uses only an absolute verified Git executable, fixed argv, and a closed environment", async () => {
    spawnSyncMock.mockImplementation(((_file: string, args?: readonly string[]) => {
      if (!Array.isArray(args)) {
        return { status: 1, stderr: "", stdout: "" } as SpawnSyncReturns<string>;
      }
      const command = args.slice(6).join(" ");
      const stdout =
        command === "rev-parse HEAD"
          ? `${revision}\n`
          : command === "rev-parse --show-toplevel"
            ? `${process.cwd()}\n`
            : command === "status --porcelain=v1 --untracked-files=all"
              ? ""
              : command === "show -s --format=%ct HEAD"
                ? "1767225600\n"
                : `${tree}\n`;
      return {
        error: Object.assign(new Error("cleanup race"), { code: "EPERM" }),
        signal: null,
        status: 0,
        stderr: "",
        stdout,
      } as unknown as SpawnSyncReturns<string>;
    }) as typeof spawnSync);

    const result = await captureRepositorySnapshot();
    expect(result.diagnostics).toEqual([]);
    const gitCalls = spawnSyncMock.mock.calls.filter((call) => Array.isArray(call[1]));
    expect(gitCalls).toHaveLength(5);
    const hardening = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
    ];
    expect(gitCalls.map((call) => call[1])).toEqual(
      [
        ["rev-parse", "HEAD"],
        ["rev-parse", "--show-toplevel"],
        ["status", "--porcelain=v1", "--untracked-files=all"],
        ["show", "-s", "--format=%ct", "HEAD"],
        ["rev-parse", "HEAD^{tree}"],
      ].map((command) => [...hardening, ...command]),
    );
    for (const [file, _args, options] of gitCalls) {
      expect(path.isAbsolute(String(file))).toBe(true);
      expect(options).toMatchObject({
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 10_000,
      });
      expect(options?.env).not.toHaveProperty("PATH");
      expect(options?.env).not.toHaveProperty("GIT_DIR");
    }
  });

  it.each([
    ["EPERM without an exit status", "EPERM", null, null],
    ["EPERM with a nonzero exit status", "EPERM", 1, null],
    ["EPERM terminated by a signal", "EPERM", 0, "SIGTERM"],
    ["a different error code", "EACCES", 0, null],
  ])("rejects %s", async (_label, code, status, signal) => {
    spawnSyncMock.mockImplementation(((_file: string, args?: readonly string[]) => {
      if (!Array.isArray(args)) {
        return { status: 1, stderr: "", stdout: "" } as SpawnSyncReturns<string>;
      }
      const command = args.slice(6).join(" ");
      const stdout =
        command === "rev-parse HEAD"
          ? `${revision}\n`
          : command === "rev-parse --show-toplevel"
            ? `${process.cwd()}\n`
            : command === "status --porcelain=v1 --untracked-files=all"
              ? ""
              : command === "show -s --format=%ct HEAD"
                ? "1767225600\n"
                : `${tree}\n`;
      return {
        error: Object.assign(new Error("spawn failure"), { code }),
        signal,
        status,
        stderr: "",
        stdout,
      } as unknown as SpawnSyncReturns<string>;
    }) as typeof spawnSync);

    await expect(captureRepositorySnapshot()).resolves.toMatchObject({
      diagnostics: ["evidence.repository.status_failed", "evidence.git.command_failed"],
      revision: null,
    });
  });
});
