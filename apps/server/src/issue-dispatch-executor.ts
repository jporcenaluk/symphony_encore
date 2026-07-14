import type { TrackerAdapter } from "@symphony/adapters";
import { dispatchIssue, type PersistenceSafetyController } from "@symphony/orchestration";
import {
  createDispatch,
  markIntentApplying,
  type OpenedDatabase,
  recordLaneMutationReceipt,
} from "@symphony/persistence";

import type { InitialIssueDispatch } from "./issue-dispatch-record.js";

export async function executeInitialIssueDispatch<LaunchResult>(input: {
  database: OpenedDatabase["database"];
  launchWorker(): Promise<LaunchResult>;
  now(): string;
  record: InitialIssueDispatch;
  safety: PersistenceSafetyController;
  tracker: TrackerAdapter;
}): Promise<LaunchResult> {
  const mutation = input.record.dispatch.issueMutation;
  if (!mutation) throw new Error("dispatch.issue_mutation_missing");
  return dispatchIssue(
    {
      attemptId: input.record.dispatch.attempt.id,
      issueId: input.record.dispatch.workRef.id,
    },
    {
      async applyLaneIntent() {
        const result = await input.tracker.updateIssueLane(
          input.record.dispatch.workRef.id,
          "In Progress",
          "dispatch.eligible",
          input.record.authority,
        );
        if (result.resultRevision === null) {
          throw new Error("tracker.dispatch_revision_missing");
        }
        return {
          providerRequestId: result.providerRequestId,
          responsePayloadHash: result.responsePayloadHash,
          result: result.result,
          resultRevision: result.resultRevision,
        };
      },
      async confirmLaneReceipt(_request, receipt) {
        const appliedAt = input.now();
        await recordLaneMutationReceipt(input.database, {
          receipt: {
            applied_at: appliedAt,
            intent_id: mutation.intent.id,
            provider_request_id: receipt.providerRequestId,
            response_payload_hash: receipt.responsePayloadHash,
            result: receipt.result,
            result_revision: receipt.resultRevision,
          },
          transition: {
            ...input.record.confirmedTransition,
            confirmedExternalRevision: receipt.resultRevision,
            enteredAt: appliedAt,
          },
        });
      },
      launchWorker: input.launchWorker,
      markIntentApplying: () => markIntentApplying(input.database, mutation.intent.id, input.now()),
      persistDispatch: () => createDispatch(input.database, input.record.dispatch),
      safety: input.safety,
    },
  );
}
