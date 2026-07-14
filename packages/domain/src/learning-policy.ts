export interface SynthesisTriggerInput {
  activeSynthesisJobs: number;
  completedIssuesSinceLastSynthesis: number;
  intervalIssues: number;
  operatorRequested: boolean;
}

export type SynthesisTriggerDecision =
  | {
      computeProfile: "deep";
      decision: "queue";
      jobKind: "synthesis";
      supervision: "supervised";
      trigger: "interval" | "operator";
    }
  | {
      decision: "wait";
      reason: "learning.interval_not_reached" | "learning.synthesis_already_active";
    };

export function decideSynthesisTrigger(input: SynthesisTriggerInput): SynthesisTriggerDecision {
  if (input.activeSynthesisJobs > 0) {
    return { decision: "wait", reason: "learning.synthesis_already_active" };
  }
  if (input.operatorRequested) return queuedSynthesis("operator");
  if (input.completedIssuesSinceLastSynthesis >= input.intervalIssues) {
    return queuedSynthesis("interval");
  }
  return { decision: "wait", reason: "learning.interval_not_reached" };
}

function queuedSynthesis(trigger: "interval" | "operator") {
  return {
    computeProfile: "deep" as const,
    decision: "queue" as const,
    jobKind: "synthesis" as const,
    supervision: "supervised" as const,
    trigger,
  };
}

export interface LearningRule {
  id: string;
  lessonIds: readonly string[];
  text: string;
}

export interface RuleChange {
  action: "add" | "update" | "remove";
  lessonIds: readonly string[];
  rationale: string;
  ruleId: string;
  text: string;
}

export type RuleChangeValidation =
  | { ok: true; rules: readonly LearningRule[] }
  | {
      ok: false;
      reason:
        | "learning.max_prompt_tokens_exceeded"
        | "learning.max_rules_exceeded"
        | "learning.rule_already_exists"
        | "learning.rule_lessons_required"
        | "learning.rule_not_found";
      ruleId?: string;
    };

export function validateRuleChanges(input: {
  changes: readonly RuleChange[];
  currentRules: readonly LearningRule[];
  maxPromptTokens: number;
  maxRules: number;
  proposedPromptTokens: number;
}): RuleChangeValidation {
  if (input.proposedPromptTokens > input.maxPromptTokens) {
    return { ok: false, reason: "learning.max_prompt_tokens_exceeded" };
  }
  for (const rule of input.currentRules) {
    if (rule.lessonIds.length === 0) {
      return { ok: false, reason: "learning.rule_lessons_required", ruleId: rule.id };
    }
  }
  const rules = new Map(input.currentRules.map((rule) => [rule.id, copyRule(rule)]));
  for (const change of input.changes) {
    if (change.lessonIds.length === 0) {
      return { ok: false, reason: "learning.rule_lessons_required", ruleId: change.ruleId };
    }
    const existing = rules.get(change.ruleId);
    if (change.action === "add") {
      if (existing) {
        return { ok: false, reason: "learning.rule_already_exists", ruleId: change.ruleId };
      }
      rules.set(change.ruleId, {
        id: change.ruleId,
        lessonIds: [...change.lessonIds],
        text: change.text,
      });
      continue;
    }
    if (!existing) {
      return { ok: false, reason: "learning.rule_not_found", ruleId: change.ruleId };
    }
    if (change.action === "remove") {
      rules.delete(change.ruleId);
    } else {
      rules.set(change.ruleId, {
        id: change.ruleId,
        lessonIds: [...change.lessonIds],
        text: change.text,
      });
    }
  }
  if (rules.size > input.maxRules) {
    return { ok: false, reason: "learning.max_rules_exceeded" };
  }
  return { ok: true, rules: [...rules.values()] };
}

function copyRule(rule: LearningRule): LearningRule {
  return { id: rule.id, lessonIds: [...rule.lessonIds], text: rule.text };
}

export function decayedRuleIds(input: {
  currentCompletedIssue: number;
  ruleDecayIssues: number;
  rules: readonly {
    createdCompletedIssue: number;
    id: string;
    lastCitedCompletedIssue: number | null;
  }[];
}): string[] {
  return input.rules
    .filter(
      (rule) =>
        input.currentCompletedIssue -
          (rule.lastCitedCompletedIssue ?? rule.createdCompletedIssue) >=
        input.ruleDecayIssues,
    )
    .map((rule) => rule.id);
}
