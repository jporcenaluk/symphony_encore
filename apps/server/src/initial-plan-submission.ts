import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentPlanSubmissionDecision } from "@symphony/adapters";
import { type Issue, isPlan, type Plan } from "@symphony/contracts";
import type { ProvisionalClassification } from "@symphony/domain";
import {
  classifyImplementationPlan,
  type PersistenceSafetyController,
  validateImplementationPlan,
} from "@symphony/orchestration";
import {
  type OpenedDatabase,
  recordAuthoritativePlanClassification,
  recordSubmittedPlan,
} from "@symphony/persistence";

export function createInitialPlanSubmissionHandler(input: {
  attemptId: string;
  database: OpenedDatabase["database"];
  issue: Pick<Issue, "acceptance_criteria">;
  now(): string;
  provisionalClassification: ProvisionalClassification;
  riskPathPatterns: readonly string[];
  safety: PersistenceSafetyController;
  trivialMaxChangedLines: number;
  trivialPathPatterns: readonly string[];
  workspacePath: string;
}): (plan: unknown) => Promise<AgentPlanSubmissionDecision> {
  return async (candidate) => {
    if (!isPlan(candidate)) return rejection("Plan violated the negotiated schema.");
    try {
      await recordSubmittedPlan(input.database, { attemptId: input.attemptId, plan: candidate });
    } catch (error) {
      return handlePlanOrPersistenceError(input.safety, error);
    }
    const gate = validateImplementationPlan({
      acceptanceCriteria: input.issue.acceptance_criteria,
      plan: candidate,
    });
    if (!gate.accepted) {
      return rejection(
        [
          `Plan revision ${candidate.revision} rejected:`,
          ...gate.objections.map((item) => `- ${item}`),
        ].join("\n"),
      );
    }
    const classification = classifyImplementationPlan({
      plan: candidate,
      provisional: input.provisionalClassification,
      riskPathPatterns: input.riskPathPatterns,
      trivialMaxChangedLines: input.trivialMaxChangedLines,
      trivialPathPatterns: input.trivialPathPatterns,
    });
    try {
      await recordAuthoritativePlanClassification(input.database, {
        attemptId: input.attemptId,
        changeClass: classification.changeClass,
        expectedProvisionalClass: input.provisionalClassification.changeClass,
        planId: candidate.id,
        reasons: classification.reasons,
        validatedAt: input.now(),
      });
    } catch (error) {
      return handlePlanOrPersistenceError(input.safety, error);
    }
    await writePlanProjection(input.workspacePath, candidate);
    return {
      accepted: true,
      message:
        classification.changeClass === "high_risk"
          ? `Plan revision ${candidate.revision} validated as high_risk. Stop implementation and report plan_ready.`
          : `Plan revision ${candidate.revision} accepted.`,
    };
  };
}

async function handlePlanOrPersistenceError(
  safety: PersistenceSafetyController,
  error: unknown,
): Promise<AgentPlanSubmissionDecision> {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (failure.message.startsWith("plan.")) return rejection(failure.message);
  await safety.recordFailure(failure);
  throw failure;
}

function rejection(message: string): AgentPlanSubmissionDecision {
  return { accepted: false, message };
}

async function writePlanProjection(workspacePath: string, plan: Plan): Promise<void> {
  const destination = path.join(workspacePath, "PLAN.md");
  const temporary = path.join(workspacePath, `.PLAN.md.${plan.id}.tmp`);
  try {
    await writeFile(temporary, renderPlanProjection(plan), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function renderPlanProjection(plan: Plan): string {
  const acceptanceCriteria = plan.acceptance_criteria
    .map(
      (criterion) =>
        `- [ ] ${criterion.criterion_text}\n  - Planned evidence: ${criterion.planned_evidence}`,
    )
    .join("\n");
  const paths = plan.proposed_paths.map((candidate) => `- \`${candidate}\``).join("\n");
  const commands = plan.verification_commands.map((command) => `- \`${command}\``).join("\n");
  const risks =
    plan.risk_facts.length === 0
      ? "- None reported"
      : plan.risk_facts.map((risk) => `- ${risk}`).join("\n");
  return [
    "# Plan",
    "",
    `Revision: ${plan.revision}`,
    "Status: validated",
    "",
    "## Approach",
    "",
    plan.approach,
    "",
    "## Acceptance criteria",
    "",
    acceptanceCriteria,
    "",
    "## Proposed paths",
    "",
    paths,
    "",
    "## Verification commands",
    "",
    commands,
    "",
    "## Estimates",
    "",
    `- Files: ${plan.estimated_files}`,
    `- Changed lines: ${plan.estimated_changed_lines}`,
    "",
    "## Risk facts",
    "",
    risks,
    "",
  ].join("\n");
}
