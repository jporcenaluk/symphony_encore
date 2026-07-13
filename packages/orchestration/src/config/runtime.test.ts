import { describe, expect, it } from "vitest";
import { parseWorkflowText } from "../workflow-loader.js";
import {
  type AppliedConfiguration,
  applyConfigurationCandidate,
  candidateHashForEntry,
} from "./application.js";
import { resolveConfiguration } from "./resolver.js";
import { reloadWorkflowRuntime, type WorkflowRuntime } from "./runtime.js";

const context = {
  environment: { SESSION_SECRET: "secret" },
  home: "/home/operator",
  processCwd: "/service",
  serviceDataRoot: "/data",
  systemTemp: "/tmp",
  workflowDirectory: "/repo",
  workflowVersion: "sha256:initial",
};

const initialSource = `---
tracker:
  kind: github
  owner: example
  project_number: 1
  repo_owner: example
  repo_name: repo
workspace:
  verify_command: make verify
agent:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
human:
  operators:
    - id: admin
      auth_subject: local:admin
      capabilities: [operator.read, config.write, config.ack]
server:
  auth_kind: local
  session_secret: $SESSION_SECRET
---
Initial prompt for {{ work_ref }}.
`;

function initialRuntime(): WorkflowRuntime {
  const parsed = parseWorkflowText(initialSource);
  const candidate = resolveConfiguration({ context, workflow: parsed.config });
  const acknowledgedHashes = new Set(Object.values(candidate.entries).map(candidateHashForEntry));
  const configuration: AppliedConfiguration = applyConfigurationCandidate({
    acknowledgedHashes,
    candidate,
  });
  return {
    activePrompt: parsed.prompt,
    activeSourceHash: "sha256:initial",
    configuration,
    lastReloadError: null,
    status: "active",
  };
}

describe("workflow runtime reload", () => {
  it("keeps the complete last known good state on malformed YAML", () => {
    const previous = initialRuntime();
    const reloaded = reloadWorkflowRuntime(previous, {
      acknowledgedHashes: new Set(),
      context,
      source: "---\ntracker: [\n---\nBroken",
      sourceHash: "sha256:broken",
    });

    expect(reloaded.activePrompt).toBe(previous.activePrompt);
    expect(reloaded.activeSourceHash).toBe(previous.activeSourceHash);
    expect(reloaded.configuration).toBe(previous.configuration);
    expect(reloaded).toMatchObject({
      lastReloadError: "workflow.front_matter_invalid",
      status: "reload_rejected",
    });
  });

  it("keeps the last known good prompt when cross-field validation fails", () => {
    const previous = initialRuntime();
    const invalidSource = initialSource
      .replace("verify_command: make verify", "verify_command: none")
      .replace("Initial prompt", "Invalid candidate prompt");
    const reloaded = reloadWorkflowRuntime(previous, {
      acknowledgedHashes: new Set(),
      context,
      source: invalidSource,
      sourceHash: "sha256:invalid",
    });

    expect(reloaded.activePrompt).toBe(previous.activePrompt);
    expect(reloaded.configuration.effectiveValues).toEqual(previous.configuration.effectiveValues);
    expect(reloaded.lastReloadError).toBe(
      "config.verify_none_reason_required:workspace.verify_none_reason",
    );
  });

  it("accepts a valid prompt while retaining pending configuration metadata", () => {
    const previous = initialRuntime();
    const changedSource = initialSource
      .replace("repo_name: repo", "repo_name: next-repo")
      .replace("Initial prompt", "Updated prompt");
    const reloaded = reloadWorkflowRuntime(previous, {
      acknowledgedHashes: new Set(),
      context,
      source: changedSource,
      sourceHash: "sha256:changed",
    });

    expect(reloaded.activePrompt).toBe("Updated prompt for {{ work_ref }}.");
    expect(reloaded.configuration.entries["tracker.repo_name"]).toMatchObject({
      acknowledgmentState: "pending",
      candidateValue: "next-repo",
      effectiveValue: "repo",
    });
    expect(reloaded.status).toBe("pending");
  });
});
