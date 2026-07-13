import type { Issue } from "@symphony/contracts";

import { evaluateIssueEligibility, sortIssueCandidates } from "./policy.js";

export type SchedulerConfigValidation =
  | {
      config: { assignee: string | null; maxConcurrent: number; requiredLabels: readonly string[] };
      ok: true;
    }
  | { errors: readonly string[]; ok: false };

export type DispatchDecision = "dispatched" | "budget_denied" | "claim_conflict";

export interface PollTickPorts {
  advanceMergeQueue(): Promise<unknown>;
  checkLearningAndFleetBudgets(): Promise<unknown>;
  dispatch(candidate: Issue): Promise<DispatchDecision>;
  fetchCandidates(): Promise<readonly Issue[]>;
  isClaimed(candidate: Issue): Promise<boolean>;
  preflight(candidate: Issue): Promise<boolean>;
  reconcileAwaitingHuman(): Promise<unknown>;
  reconcileRunning(): Promise<unknown>;
  runningSlots(): Promise<number>;
  validateConfig(): Promise<SchedulerConfigValidation>;
}

export interface PollTickResult {
  dispatched: string[];
  skippedDispatch: boolean;
}

export async function runPollTick(ports: PollTickPorts): Promise<PollTickResult> {
  await ports.reconcileRunning();
  await ports.reconcileAwaitingHuman();
  await ports.advanceMergeQueue();
  const validation = await ports.validateConfig();
  const dispatched: string[] = [];

  if (validation.ok) {
    const runningSlots = await ports.runningSlots();
    let availableSlots = Math.max(0, validation.config.maxConcurrent - runningSlots);
    if (availableSlots > 0) {
      const candidates = sortIssueCandidates(await ports.fetchCandidates());
      for (const candidate of candidates) {
        if (availableSlots < 1) break;
        const workClaimed = await ports.isClaimed(candidate);
        const basicEligibility = evaluateIssueEligibility({
          availableSlots,
          configuredAssignee: validation.config.assignee,
          issue: candidate,
          preflightPassed: true,
          requiredLabels: validation.config.requiredLabels,
          workClaimed,
        });
        if (!basicEligibility.eligible) continue;
        if (!(await ports.preflight(candidate))) continue;
        const decision = await ports.dispatch(candidate);
        if (decision === "dispatched") {
          dispatched.push(candidate.id);
          availableSlots -= 1;
        }
      }
    }
  }

  await ports.checkLearningAndFleetBudgets();
  return { dispatched, skippedDispatch: !validation.ok };
}
