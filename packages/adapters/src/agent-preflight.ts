import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { AgentAdapterManifest } from "@symphony/contracts";

import type { AgentPreflightRequest, AgentPreflightResult } from "./contracts.js";

export interface ResolvedAgentSkill {
  contentHash: string;
  name: string;
  resolvedPath: string;
}

export async function resolveRequiredSkills(input: {
  names: readonly string[];
  roots: readonly string[];
}): Promise<ResolvedAgentSkill[]> {
  const seen = new Set<string>();
  for (const name of input.names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) {
      throw new Error(`configuration.invalid_required_skill_name:${name}`);
    }
    if (seen.has(name)) throw new Error(`configuration.duplicate_required_skill:${name}`);
    seen.add(name);
  }

  const resolved: ResolvedAgentSkill[] = [];
  for (const name of input.names) {
    let match: ResolvedAgentSkill | undefined;
    for (const root of input.roots) {
      let resolvedRoot: string;
      try {
        resolvedRoot = await realpath(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const candidate = path.join(resolvedRoot, name, "SKILL.md");
      let resolvedPath: string;
      try {
        resolvedPath = await realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!isWithin(resolvedRoot, resolvedPath)) {
        throw new Error(`policy.skill_path_escape:${name}`);
      }
      const content = await readFile(resolvedPath);
      match = {
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        name,
        resolvedPath,
      };
      break;
    }
    if (!match) throw new Error(`configuration.missing_required_skill:${name}`);
    resolved.push(match);
  }
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function validateAgentPreflight(input: {
  manifest: AgentAdapterManifest;
  request: AgentPreflightRequest;
  resolvedSkills: readonly ResolvedAgentSkill[];
}): AgentPreflightResult {
  const capabilities = new Set(input.manifest.capabilities);
  for (const capability of input.request.requiredCapabilities) {
    if (!capabilities.has(capability)) {
      throw new Error(`configuration.agent_capability_missing:${capability}`);
    }
  }
  if (!sameSkills(input.request.requiredSkills, input.resolvedSkills)) {
    throw new Error("configuration.agent_skill_exposure_mismatch");
  }
  return {
    adapterVersion: input.manifest.adapter_version,
    manifest: input.manifest,
    protocolSchemaHash: input.manifest.protocol.schema_hash,
    resolvedSkills: input.resolvedSkills.map((skill) => ({ ...skill })),
    role: input.request.role,
    submitPlanSchema: input.request.submitPlanSchema ?? null,
    terminalResultSchema: input.request.terminalResultSchema,
  };
}

function sameSkills(
  expected: readonly ResolvedAgentSkill[],
  actual: readonly ResolvedAgentSkill[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (skill, index) =>
        skill.name === actual[index]?.name &&
        skill.contentHash === actual[index]?.contentHash &&
        skill.resolvedPath === actual[index]?.resolvedPath,
    )
  );
}
