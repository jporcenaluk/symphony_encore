import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createGhCliApiClient,
  createNodeGhCommandRunner,
  type GhCommandRunner,
  type GitHubApiError,
} from "./gh-cli-api.js";

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
});
