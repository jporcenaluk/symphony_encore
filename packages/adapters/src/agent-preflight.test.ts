import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAdapterManifest } from "@symphony/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRequiredSkills, validateAgentPreflight } from "./agent-preflight.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("required agent skill resolution", () => {
  it("prefers the repository root and records a stable path and content hash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-skills-"));
    directories.push(root);
    const repositoryRoot = path.join(root, "repo-skills");
    const homeRoot = path.join(root, "home-skills");
    await mkdir(path.join(repositoryRoot, "review"), { recursive: true });
    await mkdir(path.join(homeRoot, "review"), { recursive: true });
    await writeFile(path.join(repositoryRoot, "review", "SKILL.md"), "repository review\n");
    await writeFile(path.join(homeRoot, "review", "SKILL.md"), "home review\n");

    await expect(
      resolveRequiredSkills({ names: ["review"], roots: [repositoryRoot, homeRoot] }),
    ).resolves.toEqual([
      {
        contentHash: "sha256:254fc11dc6ed2ebd6d7cb83746ea57da44aafee2e9be7063a3384bcef95da7cb",
        name: "review",
        resolvedPath: path.join(repositoryRoot, "review", "SKILL.md"),
      },
    ]);
  });

  it("rejects missing, duplicate, traversal, and symlink-escaped skills", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-skills-"));
    directories.push(root);
    const skills = path.join(root, "skills");
    const outside = path.join(root, "outside");
    await mkdir(skills);
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "escaped\n");
    await symlink(outside, path.join(skills, "escaped"));

    await expect(resolveRequiredSkills({ names: ["missing"], roots: [skills] })).rejects.toThrow(
      "configuration.missing_required_skill:missing",
    );
    await expect(
      resolveRequiredSkills({ names: ["same", "same"], roots: [skills] }),
    ).rejects.toThrow("configuration.duplicate_required_skill:same");
    await expect(resolveRequiredSkills({ names: ["../outside"], roots: [skills] })).rejects.toThrow(
      "configuration.invalid_required_skill_name:../outside",
    );
    await expect(resolveRequiredSkills({ names: ["escaped"], roots: [skills] })).rejects.toThrow(
      "policy.skill_path_escape:escaped",
    );
  });
});

describe("agent manifest preflight", () => {
  const manifest: AgentAdapterManifest = {
    adapter_version: "codex-1",
    capabilities: ["terminal_result", "submit_plan", "skills"],
    price_table: {
      models: { model: { input_per_million_usd: 1, output_per_million_usd: 4 } },
      version: "prices-1",
    },
    profiles: {
      deep: { model: "model", reasoning_effort: "high" },
      economy: { model: "model", reasoning_effort: "low" },
      standard: { model: "model", reasoning_effort: "medium" },
    },
    protocol: { maximum: "2.0", minimum: "1.0", schema_hash: "sha256:protocol" },
  };
  const resolvedSkills = [
    { contentHash: "sha256:skill", name: "review", resolvedPath: "/repo/review/SKILL.md" },
  ];

  it("accepts required capabilities and exact resolved skills", () => {
    expect(
      validateAgentPreflight({
        manifest,
        request: {
          requiredCapabilities: ["terminal_result", "skills"],
          requiredSkills: resolvedSkills,
          role: "implementation",
          terminalResultSchema: {},
        },
        resolvedSkills,
      }),
    ).toEqual({
      adapterVersion: "codex-1",
      manifest,
      protocolSchemaHash: "sha256:protocol",
      resolvedSkills,
    });
  });

  it("fails before launch when a capability or skill exposure is missing", () => {
    expect(() =>
      validateAgentPreflight({
        manifest,
        request: {
          requiredCapabilities: ["terminal_result", "computer_use"],
          requiredSkills: resolvedSkills,
          role: "implementation",
          terminalResultSchema: {},
        },
        resolvedSkills,
      }),
    ).toThrow("configuration.agent_capability_missing:computer_use");
    expect(() =>
      validateAgentPreflight({
        manifest,
        request: {
          requiredCapabilities: ["terminal_result", "skills"],
          requiredSkills: resolvedSkills,
          role: "implementation",
          terminalResultSchema: {},
        },
        resolvedSkills: [],
      }),
    ).toThrow("configuration.agent_skill_exposure_mismatch");
  });
});
