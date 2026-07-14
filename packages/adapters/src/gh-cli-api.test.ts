import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createGhCliApiClient,
  createNodeGhCommandRunner,
  type GhCommandRunner,
  type GitHubApiError,
} from "./gh-cli-api.js";
import { POSIX_PROCESS_TREE_TRUST_BOUNDARY } from "./posix-process-tree.js";

function runner(result?: Partial<Awaited<ReturnType<GhCommandRunner["run"]>>>) {
  return {
    run: vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout:
        'HTTP/2.0 200 OK\r\nx-github-request-id: REQ_123\r\ncontent-type: application/json\r\n\r\n{"data":{"node":{"id":"project-1"}}}',
      ...result,
    })),
  } satisfies GhCommandRunner;
}

describe("gh CLI API transport", () => {
  it("sends GraphQL JSON over stdin with allowlisted host auth and returns the request id", async () => {
    const command = runner();
    const client = createGhCliApiClient({
      environment: {
        GH_HOST: "github.example.test",
        GH_TOKEN: "host-token",
        HOME: "/home/service",
        PATH: "/usr/bin",
        UNRELATED_SECRET: "must-not-cross",
      },
      runner: command,
      timeoutMs: 5_000,
    });

    await expect(
      client.graphql<{ node: { id: string } }>("query($id: ID!) { node(id: $id) { id } }", {
        id: "project-1",
      }),
    ).resolves.toEqual({ data: { node: { id: "project-1" } }, requestId: "REQ_123" });
    expect(command.run).toHaveBeenCalledWith({
      arguments: ["api", "graphql", "--include", "--input", "-"],
      command: "gh",
      environment: {
        GH_HOST: "github.example.test",
        GH_TOKEN: "host-token",
        HOME: "/home/service",
        PATH: "/usr/bin",
      },
      maxOutputBytes: 2_000_000,
      stdin: JSON.stringify({
        query: "query($id: ID!) { node(id: $id) { id } }",
        variables: { id: "project-1" },
      }),
      timeoutMs: 5_000,
    });
  });

  it("sends bounded REST requests and exposes complete-page metadata", async () => {
    const command = runner({
      stdout:
        'HTTP/2.0 201 Created\r\nx-github-request-id: REQ_REST\r\nlink: <https://api.github.test/resource?page=2>; rel="next"\r\n\r\n{"number":42,"url":"https://api.github.test/pulls/42"}',
    });
    const client = createGhCliApiClient({
      environment: { GH_TOKEN: "host-token", PATH: "/usr/bin" },
      runner: command,
      timeoutMs: 5_000,
    });

    await expect(
      client.rest<{ number: number; url: string }>({
        body: { base: "main", head: "symphony/issue-1" },
        method: "POST",
        path: "repos/owner/repo/pulls",
      }),
    ).resolves.toEqual({
      data: { number: 42, url: "https://api.github.test/pulls/42" },
      nextPageUrl: "https://api.github.test/resource?page=2",
      requestId: "REQ_REST",
    });
    expect(command.run).toHaveBeenCalledWith({
      arguments: ["api", "repos/owner/repo/pulls", "--include", "--method", "POST", "--input", "-"],
      command: "gh",
      environment: { GH_TOKEN: "host-token", PATH: "/usr/bin" },
      maxOutputBytes: 2_000_000,
      stdin: JSON.stringify({ base: "main", head: "symphony/issue-1" }),
      timeoutMs: 5_000,
    });
  });

  it("classifies CLI authentication failures without returning provider prose", async () => {
    const client = createGhCliApiClient({
      environment: {},
      runner: runner({ exitCode: 1, stderr: "HTTP 401: Bad credentials", stdout: "" }),
      timeoutMs: 5_000,
    });

    await expect(client.graphql("query { viewer { login } }", {})).rejects.toEqual(
      expect.objectContaining<Partial<GitHubApiError>>({ code: "github.auth_failed" }),
    );
  });

  it("fails closed for GraphQL errors, missing request ids, and malformed payloads", async () => {
    for (const [stdout, code] of [
      [
        'HTTP/2.0 200 OK\nX-GitHub-Request-Id: REQ\n\n{"data":null,"errors":[{"type":"FORBIDDEN","message":"denied"}]}',
        "github.auth_failed",
      ],
      ['HTTP/2.0 200 OK\n\n{"data":{}}', "github.missing_request_id"],
      ["not-http-or-json", "github.invalid_response"],
    ] as const) {
      const client = createGhCliApiClient({
        environment: {},
        runner: runner({ stdout }),
        timeoutMs: 5_000,
      });
      await expect(client.graphql("query { viewer { login } }", {})).rejects.toEqual(
        expect.objectContaining<Partial<GitHubApiError>>({ code }),
      );
    }
  });

  it("runs the real gh subprocess boundary with bounded output and stdin", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-gh-runner-"));
    try {
      const executable = path.join(directory, "gh");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          "body=$(cat)",
          "printf 'HTTP/2.0 200 OK\\nX-GitHub-Request-Id: REAL_REQ\\n\\n'",
          "printf '%s' \"$body\"",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      const result = await createNodeGhCommandRunner().run({
        arguments: ["api", "graphql", "--include", "--input", "-"],
        command: "gh",
        environment: { PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}` },
        maxOutputBytes: 10_000,
        stdin: '{"data":{"ok":true}}',
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain("X-GitHub-Request-Id: REAL_REQ");
      expect(result.stdout).toContain('{"data":{"ok":true}}');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["printf '01234567890123456789'", 1_000, 10, "gh.output_limit"],
    ["while :; do :; done", 10, 10_000, "gh.timeout"],
  ] as const)("terminates a real gh subprocess at resource boundaries", async (body, timeoutMs, maxOutputBytes, error) => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-gh-bounds-"));
    try {
      const executable = path.join(directory, "gh");
      await writeFile(executable, `#!/bin/sh\n${body}\n`);
      await chmod(executable, 0o755);
      await expect(
        createNodeGhCommandRunner().run({
          arguments: [],
          command: "gh",
          environment: { PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}` },
          maxOutputBytes,
          stdin: "",
          timeoutMs,
        }),
      ).rejects.toThrow(error);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains the launch-time group anchor until same-group descendants exit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-gh-group-anchor-"));
    const executable = path.join(directory, "gh");
    const pidFile = path.join(directory, "pid");
    let descendantPid = 0;
    try {
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 400)"], { stdio: "ignore" });',
          "writeFileSync(process.env.SYMPHONY_PID_FILE, String(descendant.pid));",
          "process.exit(0);",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      const startedAt = Date.now();

      await expect(
        createNodeGhCommandRunner().run({
          arguments: [],
          command: "gh",
          environment: {
            PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            SYMPHONY_PID_FILE: pidFile,
          },
          maxOutputBytes: 10_000,
          stdin: "",
          timeoutMs: 2_000,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      descendantPid = Number(await readFile(pidFile, "utf8"));
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
      expect(isActiveProcess(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("terminates a real trusted child tree when parent-side process-group signaling is denied", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-gh-process-tree-"));
    const executable = path.join(directory, "gh");
    const pidFile = path.join(directory, "pids");
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    });
    let spawnedPids: number[] = [];
    try {
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          "sleep 30 &",
          'descendant_pid="$!"',
          'printf "%s\\n%s\\n" "$$" "$descendant_pid" > "$SYMPHONY_PID_FILE"',
          'wait "$descendant_pid"',
        ].join("\n"),
      );
      await chmod(executable, 0o755);

      await expect(
        createNodeGhCommandRunner().run({
          arguments: [],
          command: "gh",
          environment: {
            PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            SYMPHONY_PID_FILE: pidFile,
          },
          maxOutputBytes: 10_000,
          stdin: "",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("gh.timeout");
      spawnedPids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
      expect(spawnedPids).toHaveLength(2);
      expect(spawnedPids.every((pid) => !isActiveProcess(pid))).toBe(true);
    } finally {
      kill.mockRestore();
      for (const pid of spawnedPids) {
        try {
          originalKill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "records a real double-fork setsid attempt as outside the trusted gh/git containment guarantee",
    async () => {
      expect(POSIX_PROCESS_TREE_TRUST_BOUNDARY).toBe(
        "trusted_gh_git_must_remain_in_launch_supervisor_group",
      );
      const directory = await mkdtemp(path.join(tmpdir(), "symphony-gh-setsid-boundary-"));
      const executable = path.join(directory, "gh");
      const pidFile = path.join(directory, "pids");
      let spawnedPids: number[] = [];
      try {
        await writeFile(
          executable,
          [
            `#!${process.execPath}`,
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            "writeFileSync(process.env.SYMPHONY_PID_FILE, String(process.pid) + '\\n');",
            'const daemonSource = `const { appendFileSync, readFileSync } = require("node:fs"); const pgid = readFileSync("/proc/self/stat", "utf8").split(" ")[4]; appendFileSync(process.env.SYMPHONY_PID_FILE, String(process.pid) + ":" + pgid + String.fromCharCode(10)); setInterval(() => {}, 1000);`;',
            'const escaped = spawn("/usr/bin/setsid", ["--fork", process.execPath, "-e", daemonSource], { env: process.env, stdio: "ignore" });',
            "escaped.unref();",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        );
        await chmod(executable, 0o755);

        await expect(
          createNodeGhCommandRunner().run({
            arguments: [],
            command: "gh",
            environment: {
              PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
              SYMPHONY_PID_FILE: pidFile,
            },
            maxOutputBytes: 10_000,
            stdin: "",
            timeoutMs: 1_000,
          }),
        ).rejects.toThrow("gh.timeout");
        const pidLines = (await readFile(pidFile, "utf8")).trim().split("\n");
        const [daemonPidText, daemonPgidText] = (pidLines[1] ?? "").split(":");
        spawnedPids = [Number(pidLines[0]), Number(daemonPidText)];
        expect(spawnedPids).toHaveLength(2);
        expect(Number(daemonPgidText)).toBe(spawnedPids[1]);
        expect(isActiveProcess(spawnedPids[0] ?? 0)).toBe(false);
      } finally {
        for (const pid of spawnedPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await rm(directory, { force: true, recursive: true });
      }
    },
  );
});

function isActiveProcess(pid: number): boolean {
  try {
    const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}
