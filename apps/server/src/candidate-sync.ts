import { collectAllPages, type TrackerAdapter } from "@symphony/adapters";
import type { Issue } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";

export async function syncTrackerCandidates(input: {
  observeIssue(issue: Issue, providerRevision: string): Promise<unknown>;
  safety: PersistenceSafetyController;
  tracker: TrackerAdapter;
}): Promise<Issue[]> {
  const candidates = await collectAllPages((cursor) => input.tracker.fetchCandidates(cursor));
  if (candidates.length === 0) return [];
  const ids = candidates.map((candidate) => candidate.id);
  const states = await collectAllPages((cursor) => input.tracker.fetchStatesByIds(ids, cursor));
  const revisionById = new Map<string, string>();
  for (const state of states) {
    if (revisionById.has(state.id)) throw new Error(`tracker.duplicate_candidate:${state.id}`);
    revisionById.set(state.id, state.revision);
  }
  for (const candidate of candidates) {
    if (!revisionById.has(candidate.id)) {
      throw new Error(`tracker.candidate_revision_missing:${candidate.id}`);
    }
  }
  try {
    for (const candidate of candidates) {
      await input.observeIssue(candidate, revisionById.get(candidate.id) as string);
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await input.safety.recordFailure(failure);
    throw failure;
  }
  return candidates;
}
