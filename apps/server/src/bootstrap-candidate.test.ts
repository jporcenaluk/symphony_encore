import { describe, expect, it } from "vitest";

import { buildBootstrapCandidate } from "./bootstrap-candidate.js";
import { parseRuntimeOptions } from "./runtime-options.js";

const workflow = {
  config: {
    agent: {
      approval_policy: "on-request",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: "workspace-write",
    },
    server: { auth_kind: "local" },
    tracker: {
      kind: "github",
      owner: "example",
      project_number: 7,
      repo_name: "repo",
      repo_owner: "example",
    },
    workspace: { verify_command: "make verify" },
  },
  path: "/srv/symphony/WORKFLOW.md",
  prompt: "Complete {{ issue.title }}.",
  sourceHash: "sha256:workflow-source",
  warnings: [],
};

describe("trusted bootstrap candidate", () => {
  it("binds local authority and runtime paths without secrets and remains stable across time", () => {
    const options = parseRuntimeOptions(
      {
        SYMPHONY_BOOTSTRAP_AUTH_SUBJECT: "local:admin",
        SYMPHONY_BOOTSTRAP_CREDENTIAL: "one-time-secret",
      },
      "/srv/symphony",
    );

    const first = buildBootstrapCandidate({
      createdAt: "2026-07-13T10:00:00Z",
      environment: {},
      home: "/home/operator",
      options,
      systemTemp: "/tmp",
      workflow,
    });
    const second = buildBootstrapCandidate({
      createdAt: "2026-07-13T11:00:00Z",
      environment: {},
      home: "/home/operator",
      options,
      systemTemp: "/tmp",
      workflow,
    });
    expect(first?.candidateHash).toBe(second?.candidateHash);
    expect(first?.configSnapshot.effectiveConfig).toMatchObject({
      "human.operators": [
        {
          auth_subject: "local:admin",
          id: "bootstrap-admin",
        },
      ],
      "persistence.database_path": "/srv/symphony/.symphony/symphony.sqlite3",
      "server.auth_kind": "local",
      "server.host": "127.0.0.1",
      "server.port": 8080,
      "tracker.project_number": 7,
      "workflow.path": "/srv/symphony/WORKFLOW.md",
    });
    expect(first?.configSnapshot.promptHash).not.toBe("sha256:");
    expect(first?.configSnapshot.workflowSourceHash).toBe("sha256:workflow-source");
    expect(first?.configSnapshot.sourceMetadata).toMatchObject({
      "tracker.project_number": { source: "workflow" },
      "workflow.path": { source: "bootstrap" },
    });
    expect(JSON.stringify(first)).not.toContain("one-time-secret");
    expect(
      buildBootstrapCandidate({
        createdAt: "t0",
        environment: {},
        home: "/home/operator",
        options: parseRuntimeOptions({}, "/srv/symphony"),
        systemTemp: "/tmp",
        workflow,
      }),
    ).toBeUndefined();
  });

  it("rejects every invalid non-operator field before exposing bootstrap", () => {
    const options = parseRuntimeOptions(
      {
        SYMPHONY_BOOTSTRAP_AUTH_SUBJECT: "local:admin",
        SYMPHONY_BOOTSTRAP_CREDENTIAL: "one-time-secret",
      },
      "/srv/symphony",
    );

    expect(() =>
      buildBootstrapCandidate({
        createdAt: "2026-07-13T10:00:00Z",
        environment: {},
        home: "/home/operator",
        options,
        systemTemp: "/tmp",
        workflow: {
          ...workflow,
          config: { ...workflow.config, workspace: { verify_command: "none" } },
        },
      }),
    ).toThrow("bootstrap.configuration_invalid:config.verify_none_reason_required");
  });
});
