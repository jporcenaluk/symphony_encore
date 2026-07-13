export interface AbsoluteUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageDelta extends AbsoluteUsage {
  totalTokens: number;
}

export interface AppliedUsage {
  delta: UsageDelta;
  latest: AbsoluteUsage;
}

export function applyAbsoluteUsage(previous: AbsoluteUsage, reported: AbsoluteUsage): AppliedUsage {
  const latest = {
    inputTokens: Math.max(previous.inputTokens, reported.inputTokens),
    outputTokens: Math.max(previous.outputTokens, reported.outputTokens),
  };
  const delta = {
    inputTokens: latest.inputTokens - previous.inputTokens,
    outputTokens: latest.outputTokens - previous.outputTokens,
    totalTokens:
      latest.inputTokens - previous.inputTokens + (latest.outputTokens - previous.outputTokens),
  };
  return { delta, latest };
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new RangeError("A percentile requires at least one value");
  if (percentile <= 0 || percentile > 1) {
    throw new RangeError("Percentile must be greater than zero and at most one");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  const selected = sorted[index];
  if (selected === undefined) throw new RangeError("Percentile index is outside the sample");
  return selected;
}

export interface UsageEstimateInput {
  configuredEstimate: number;
  history: readonly number[];
  historyMinSamples: number;
  historyWindowSamples: number;
}

export function estimateUsage(input: UsageEstimateInput): number {
  if (input.history.length < input.historyMinSamples) return input.configuredEstimate;
  const recent = input.history.slice(-input.historyWindowSamples);
  return Math.max(input.configuredEstimate, nearestRankPercentile(recent, 0.75));
}

export interface LedgerReservationRequest {
  id: string;
  remaining: number;
  requested: number;
}

export type ReservationDecision =
  | { allow: true }
  | { allow: false; exhaustedLedgerIds: readonly string[] };

export function decideReservation(
  requests: readonly LedgerReservationRequest[],
): ReservationDecision {
  const exhaustedLedgerIds = requests
    .filter((request) => request.requested > request.remaining)
    .map((request) => request.id);
  return exhaustedLedgerIds.length === 0 ? { allow: true } : { allow: false, exhaustedLedgerIds };
}
