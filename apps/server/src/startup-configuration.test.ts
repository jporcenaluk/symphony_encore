import {
  applyConfigurationCandidate,
  CONFIGURATION_KEYS,
  candidateHashForEntry,
  resolveConfiguration,
} from "@symphony/orchestration";
import type { ConfigurationSnapshot } from "@symphony/persistence";
import { describe, expect, it } from "vitest";

import { parseRuntimeOptions } from "./runtime-options.js";
import { createStartupConfiguration } from "./startup-configuration.js";

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
      project_number: 1,
      repo_name: "repo",
      repo_owner: "example",
    },
    workspace: { verify_command: "make verify" },
  },
  path: "/srv/symphony/WORKFLOW.md",
  prompt: "Complete {{ issue.title }}.",
  sourceHash: "sha256:workflow-v1",
  warnings: ["workflow.unknown_key:future"],
};

const options = parseRuntimeOptions({}, "/srv/symphony");
const operatorOverride = {
  key: "human.operators" as const,
  value: [
    {
      auth_subject: "local:admin",
      capabilities: ["operator.read", "config.write", "config.ack"],
      id: "bootstrap-admin",
    },
  ],
  version: 1,
};

function previousSnapshot(): ConfigurationSnapshot {
  const candidate = resolveConfiguration({
    bootstrap: {
      "persistence.database_path": options.databasePath,
      "workflow.path": options.workflowPath,
    },
    context: {
      authSuppliesSessions: true,
      environment: {},
      home: "/home/operator",
      processCwd: "/srv/symphony",
      serviceDataRoot: "/srv/symphony/.symphony",
      systemTemp: "/tmp",
      workflowDirectory: "/srv/symphony",
      workflowVersion: workflow.sourceHash,
    },
    overrides: [operatorOverride],
    workflow: workflow.config,
  });
  const acknowledgedHashes = new Set(
    CONFIGURATION_KEYS.map((key) => candidateHashForEntry(candidate.entries[key])),
  );
  const applied = applyConfigurationCandidate({ acknowledgedHashes, candidate });
  return {
    acknowledgmentState: Object.fromEntries(CONFIGURATION_KEYS.map((key) => [key, "acknowledged"])),
    adapterVersions: { auth: "local:1" },
    createdAt: "2026-07-13T10:00:00Z",
    effectiveConfig: applied.effectiveValues,
    id: "snapshot-1",
    operatorOverrideRevision: 1,
    promptHash: "sha256:prompt-v1",
    restartState: Object.fromEntries(CONFIGURATION_KEYS.map((key) => [key, "active"])),
    sourceMetadata: Object.fromEntries(
      CONFIGURATION_KEYS.map((key) => [
        key,
        { source: candidate.entries[key].source, version: candidate.entries[key].version },
      ]),
    ),
    workflowSourceHash: workflow.sourceHash,
  };
}

describe("ordinary startup configuration", () => {
  it("loads the workflow and durable operator override into a new immutable snapshot", () => {
    const startup = createStartupConfiguration({
      acknowledgedHashes: new Set(),
      createdAt: "2026-07-13T11:00:00Z",
      environment: {},
      home: "/home/operator",
      id: "snapshot-2",
      options,
      overrides: [operatorOverride],
      previousSnapshot: previousSnapshot(),
      systemTemp: "/tmp",
      workflow,
    });

    expect(startup.configuration.status).toBe("active");
    expect(startup.snapshot).toMatchObject({
      id: "snapshot-2",
      operatorOverrideRevision: 1,
      workflowSourceHash: "sha256:workflow-v1",
    });
    expect(startup.snapshot.effectiveConfig["human.operators"]).toEqual(operatorOverride.value);
    expect(startup.snapshot.sourceMetadata["human.operators"]).toEqual({
      source: "operator_override",
      version: "override:1",
    });
    expect(startup.warnings).toEqual(["workflow.unknown_key:future"]);
  });

  it("fails startup without changing the last known snapshot when the candidate is invalid", () => {
    expect(() =>
      createStartupConfiguration({
        acknowledgedHashes: new Set(),
        createdAt: "2026-07-13T11:00:00Z",
        environment: {},
        home: "/home/operator",
        id: "snapshot-invalid",
        options,
        overrides: [operatorOverride],
        previousSnapshot: previousSnapshot(),
        systemTemp: "/tmp",
        workflow: {
          ...workflow,
          config: { ...workflow.config, workspace: { verify_command: "none" } },
          sourceHash: "sha256:invalid",
        },
      }),
    ).toThrow(
      "startup.configuration_invalid:config.verify_none_reason_required:workspace.verify_none_reason",
    );
  });
});
