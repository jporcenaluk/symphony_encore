import { describe, expect, it } from "vitest";

import {
  type AppliedConfiguration,
  applyConfigurationCandidate,
  candidateHashForEntry,
} from "./application.js";
import { type ConfigurationResolution, resolveConfiguration } from "./resolver.js";

const context = {
  environment: { SESSION_SECRET: "secret" },
  home: "/home/operator",
  processCwd: "/service",
  serviceDataRoot: "/data",
  systemTemp: "/tmp",
  workflowDirectory: "/repo",
  workflowVersion: "workflow:v1",
};

const baseWorkflow = {
  agent: {
    approval_policy: "on-request",
    max_concurrent: 4,
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: "workspace-write",
  },
  human: {
    operators: [
      {
        auth_subject: "local:admin",
        capabilities: ["operator.read", "config.write", "config.ack"],
        id: "admin",
      },
    ],
  },
  server: { auth_kind: "local", host: "127.0.0.1", session_secret: "$SESSION_SECRET" },
  tracker: {
    kind: "github",
    owner: "example",
    project_number: 1,
    repo_name: "repo",
    repo_owner: "example",
    status_field: "Status",
  },
  workspace: { verify_command: "make verify" },
};

function resolve(
  workflow = baseWorkflow,
  overrides: Parameters<typeof resolveConfiguration>[0]["overrides"] = [],
) {
  return resolveConfiguration({ context, overrides, workflow });
}

function trustEveryCandidate(candidate: ConfigurationResolution): Set<string> {
  return new Set(Object.values(candidate.entries).map(candidateHashForEntry));
}

function initialConfiguration(): AppliedConfiguration {
  const candidate = resolve();
  return applyConfigurationCandidate({
    acknowledgedHashes: trustEveryCandidate(candidate),
    candidate,
  });
}

describe("configuration candidate application", () => {
  it("holds workflow ack+ and file-ack+ changes at the last known good values", () => {
    const previous = initialConfiguration();
    const candidate = resolve({
      ...baseWorkflow,
      agent: { ...baseWorkflow.agent, max_concurrent: 6 },
      tracker: { ...baseWorkflow.tracker, status_field: "State" },
    });

    const applied = applyConfigurationCandidate({
      acknowledgedHashes: new Set(),
      candidate,
      previous,
    });

    expect(applied.effectiveValues["agent.max_concurrent"]).toBe(4);
    expect(applied.effectiveValues["tracker.status_field"]).toBe("Status");
    expect(applied.entries["agent.max_concurrent"]).toMatchObject({
      acknowledgmentState: "pending",
      candidateValue: 6,
      effectiveValue: 4,
    });
    expect(applied.entries["tracker.status_field"].acknowledgmentState).toBe("pending");
  });

  it("applies an acknowledged hot change but holds restart changes until restart", () => {
    const previous = initialConfiguration();
    const candidate = resolve({
      ...baseWorkflow,
      server: { ...baseWorkflow.server, host: "0.0.0.0" },
      tracker: { ...baseWorkflow.tracker, status_field: "State" },
    });
    const acknowledgedHashes = new Set([
      candidateHashForEntry(candidate.entries["server.host"]),
      candidateHashForEntry(candidate.entries["tracker.status_field"]),
    ]);

    const applied = applyConfigurationCandidate({ acknowledgedHashes, candidate, previous });

    expect(applied.effectiveValues["tracker.status_field"]).toBe("State");
    expect(applied.entries["tracker.status_field"].reloadState).toBe("active");
    expect(applied.effectiveValues["server.host"]).toBe("127.0.0.1");
    expect(applied.entries["server.host"]).toMatchObject({
      acknowledgmentState: "acknowledged",
      candidateValue: "0.0.0.0",
      reloadState: "pending_restart",
    });
  });

  it("applies an acknowledged restart candidate at the startup boundary", () => {
    const previous = initialConfiguration();
    const candidate = resolve({
      ...baseWorkflow,
      server: { ...baseWorkflow.server, host: "0.0.0.0" },
    });

    const applied = applyConfigurationCandidate({
      acknowledgedHashes: new Set([candidateHashForEntry(candidate.entries["server.host"])]),
      candidate,
      previous,
      restartBoundaryReached: true,
    });

    expect(applied.entries["server.host"]).toMatchObject({
      acknowledgmentState: "acknowledged",
      effectiveValue: "0.0.0.0",
      reloadState: "active",
    });
  });

  it("treats an authorized file-ack+ override as its acknowledgment", () => {
    const previous = initialConfiguration();
    const candidate = resolve(baseWorkflow, [
      { key: "agent.max_concurrent", value: 8, version: 2 },
    ]);

    const applied = applyConfigurationCandidate({
      acknowledgedHashes: new Set(),
      candidate,
      previous,
    });

    expect(applied.effectiveValues["agent.max_concurrent"]).toBe(8);
    expect(applied.entries["agent.max_concurrent"].acknowledgmentState).toBe("acknowledged");
  });

  it("keeps the complete previous configuration when a reload candidate is invalid", () => {
    const previous = initialConfiguration();
    const candidate = resolve({
      ...baseWorkflow,
      workspace: { verify_command: "none" },
    });

    const applied = applyConfigurationCandidate({
      acknowledgedHashes: new Set(),
      candidate,
      previous,
    });

    expect(applied.status).toBe("candidate_invalid");
    expect(applied.effectiveValues).toEqual(previous.effectiveValues);
    expect(applied.errors).toContainEqual({
      code: "config.verify_none_reason_required",
      key: "workspace.verify_none_reason",
    });
  });
});
