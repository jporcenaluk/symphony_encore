import type { SynthesisResult } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import {
  planSynthesisFailureClosure,
  validateSynthesisResult,
} from "./synthesis-attempt-closure.js";

const proposal: SynthesisResult = {
  branch: "symphony/system-synthesis-1",
  cited_lesson_ids: ["lesson-1"],
  decision: "propose_changes",
  evidence: [{ kind: "commit", sha: "abc1234" }],
  handoff: {
    acceptance_criteria: ["cite lessons"],
    commands: [{ command: "make verify-fast", exit_code: 0 }],
    decisions_fixed: [],
    files_changed: ["WORKFLOW.md"],
    goal: "Improve workflow rules",
    open_items: [],
    revision: "abc1234",
  },
  pull_request: { base_ref: "main", title: "Improve workflow rules" },
  repository_revision: "abc1234",
  rule_changes: [
    {
      action: "add",
      lesson_ids: ["lesson-1"],
      rationale: "Prevent recurrence",
      rule_id: "rule-new",
      text: "Require current-head checks",
    },
  ],
};

describe("synthesis result validation", () => {
  it("accepts a revision-pinned, lesson-backed proposal within saturation caps", () => {
    expect(
      validateSynthesisResult(proposal, {
        currentRules: [],
        knownLessonIds: ["lesson-1"],
        maxPromptTokens: 4_000,
        maxRules: 25,
        repositoryRevision: "abc1234",
      }),
    ).toEqual(proposal);
  });

  it("rejects unknown or uncited lesson evidence", () => {
    expect(() =>
      validateSynthesisResult(
        { ...proposal, cited_lesson_ids: [] },
        {
          currentRules: [],
          knownLessonIds: ["lesson-1"],
          maxPromptTokens: 4_000,
          maxRules: 25,
          repositoryRevision: "abc1234",
        },
      ),
    ).toThrow("synthesis.lesson_citation_missing:lesson-1");
    expect(() =>
      validateSynthesisResult(proposal, {
        currentRules: [],
        knownLessonIds: [],
        maxPromptTokens: 4_000,
        maxRules: 25,
        repositoryRevision: "abc1234",
      }),
    ).toThrow("synthesis.lesson_unknown:lesson-1");
  });

  it("rejects a stale repository revision and hard-cap overflow", () => {
    expect(() =>
      validateSynthesisResult(proposal, {
        currentRules: [],
        knownLessonIds: ["lesson-1"],
        maxPromptTokens: 4_000,
        maxRules: 25,
        repositoryRevision: "def5678",
      }),
    ).toThrow("synthesis.repository_revision_mismatch");
    expect(() =>
      validateSynthesisResult(proposal, {
        currentRules: [],
        knownLessonIds: ["lesson-1"],
        maxPromptTokens: 1,
        maxRules: 25,
        repositoryRevision: "abc1234",
      }),
    ).toThrow("learning.max_prompt_tokens_exceeded");
  });
});

describe("synthesis failure closure", () => {
  const failureState = {
    agentProcessFailures: 0,
    firstInfrastructureFailureAt: null,
    infrastructureFailures: 0,
    retryEntries: 0,
  };
  const policy = {
    endedAt: "2026-07-13T10:02:00Z",
    maxFailureRetries: 2,
    maxRetryBackoffMs: 60_000,
    retryJitterSample: 0.5,
  };

  it("queues a bounded retry for retryable execution failure", () => {
    expect(
      planSynthesisFailureClosure(
        policy,
        { errorCode: "process_exit", kind: "failure", providerReason: "worker exited" },
        failureState,
      ),
    ).toEqual({
      nextClaim: {
        dueAt: "2026-07-13T10:02:00.000Z",
        mode: "RetryQueued",
        reason: "synthesis_retry_required",
      },
      retryEntry: {
        dueAt: "2026-07-13T10:02:00.000Z",
        failureClass: "agent_process",
        lastError: "worker exited",
        maxRetries: 2,
        retryNumber: 1,
      },
      targetStage: "rework",
    });
  });

  it("parks after the retry limit is reached", () => {
    expect(
      planSynthesisFailureClosure(
        policy,
        { errorCode: "process_exit", kind: "failure", providerReason: "worker exited" },
        { ...failureState, agentProcessFailures: 2, retryEntries: 2 },
      ),
    ).toMatchObject({
      nextClaim: { mode: "AwaitingHuman", reason: "agent_process" },
      retryEntry: null,
      targetStage: "human",
    });
  });
});
