import { parseWorkflowText } from "../workflow-loader.js";
import { type AppliedConfiguration, applyConfigurationCandidate } from "./application.js";
import {
  type ConfigurationOverride,
  type ResolutionContext,
  resolveConfiguration,
} from "./resolver.js";

export interface WorkflowRuntime {
  activePrompt: string;
  activeSourceHash: string;
  configuration: AppliedConfiguration;
  lastReloadError: string | null;
  status: "active" | "pending" | "reload_rejected";
}

export interface ReloadWorkflowRuntimeInput {
  acknowledgedHashes: ReadonlySet<string>;
  bootstrap?: Readonly<Record<string, unknown>>;
  context: ResolutionContext;
  overrides?: readonly ConfigurationOverride[];
  source: string;
  sourceHash: string;
}

export function reloadWorkflowRuntime(
  previous: WorkflowRuntime,
  input: ReloadWorkflowRuntimeInput,
): WorkflowRuntime {
  let parsed: ReturnType<typeof parseWorkflowText>;
  try {
    parsed = parseWorkflowText(input.source);
  } catch (error) {
    return {
      ...previous,
      lastReloadError: error instanceof Error ? error.message : "workflow.reload_unknown_error",
      status: "reload_rejected",
    };
  }

  const candidate = resolveConfiguration({
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    context: { ...input.context, workflowVersion: input.sourceHash },
    ...(input.overrides ? { overrides: input.overrides } : {}),
    workflow: parsed.config,
  });
  const configuration = applyConfigurationCandidate({
    acknowledgedHashes: input.acknowledgedHashes,
    candidate,
    previous: previous.configuration,
  });
  if (configuration.status === "candidate_invalid") {
    const error = candidate.errors[0];
    return {
      ...previous,
      lastReloadError: error ? `${error.code}:${error.key}` : "workflow.reload_invalid",
      status: "reload_rejected",
    };
  }
  return {
    activePrompt: parsed.prompt,
    activeSourceHash: input.sourceHash,
    configuration,
    lastReloadError: null,
    status: configuration.status,
  };
}
