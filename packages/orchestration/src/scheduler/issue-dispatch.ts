import type { PersistenceSafetyController } from "./persistence-safety.js";

export interface IssueDispatchRequest {
  attemptId: string;
  issueId: string;
}

export interface LaneMutationReceipt {
  providerRequestId: string;
  resultRevision: string;
}

export interface IssueDispatchPorts<LaunchResult> {
  applyLaneIntent(request: IssueDispatchRequest): Promise<LaneMutationReceipt>;
  confirmLaneReceipt(request: IssueDispatchRequest, receipt: LaneMutationReceipt): Promise<unknown>;
  launchWorker(request: IssueDispatchRequest): Promise<LaunchResult>;
  persistDispatch(request: IssueDispatchRequest): Promise<unknown>;
  safety: PersistenceSafetyController;
}

export async function dispatchIssue<LaunchResult>(
  request: IssueDispatchRequest,
  ports: IssueDispatchPorts<LaunchResult>,
): Promise<LaunchResult> {
  ports.safety.assertDispatchAllowed();
  try {
    await ports.persistDispatch(request);
  } catch (error) {
    const failure = asError(error);
    await ports.safety.recordFailure(failure);
    throw failure;
  }

  const receipt = await ports.applyLaneIntent(request);
  try {
    await ports.confirmLaneReceipt(request, receipt);
  } catch (error) {
    const failure = asError(error);
    await ports.safety.recordFailure(failure);
    throw failure;
  }
  ports.safety.assertDispatchAllowed();
  return ports.launchWorker(request);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
