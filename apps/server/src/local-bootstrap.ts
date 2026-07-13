import { timingSafeEqual } from "node:crypto";
import { hashLocalPassword, hashOpaqueSecret } from "@symphony/adapters";
import {
  type ConfigurationSnapshot,
  completeInitialBootstrap,
  type OpenedDatabase,
} from "@symphony/persistence";

import type { ControlApiDependencies } from "./control-api.js";

export interface LocalBootstrapInput {
  afterCompleted(): Promise<void>;
  authSubject: string;
  candidateHash: string;
  configSnapshot: ConfigurationSnapshot;
  database: OpenedDatabase["database"];
  expectedCredentialHash: string;
  newActionId(): string;
  now(): string;
  operatorId: string;
}

export function createLocalBootstrap(
  input: LocalBootstrapInput,
): NonNullable<ControlApiDependencies["bootstrap"]> {
  let disabled = false;
  return {
    async complete(request) {
      if (disabled) return { kind: "already_initialized" };
      if (request.authSubject !== input.authSubject) {
        return { kind: "validation_failed", message: "Bootstrap subject does not match candidate" };
      }
      const presentedCredentialHash = hashOpaqueSecret(request.bootstrapCredential);
      if (!constantTimeEqual(input.expectedCredentialHash, presentedCredentialHash)) {
        return { kind: "credential_mismatch" };
      }
      if (!constantTimeEqual(input.candidateHash, request.confirmedCandidateHash)) {
        return { kind: "candidate_mismatch" };
      }
      const credential = await hashLocalPassword(request.password);
      const result = await completeInitialBootstrap(input.database, {
        actionId: input.newActionId(),
        authSubject: request.authSubject,
        candidateHash: input.candidateHash,
        confirmedCandidateHash: request.confirmedCandidateHash,
        configSnapshot: input.configSnapshot,
        consumedAt: input.now(),
        credential,
        expectedBootstrapCredentialHash: input.expectedCredentialHash,
        operatorId: input.operatorId,
        presentedBootstrapCredentialHash: presentedCredentialHash,
        trackerLogin: request.trackerLogin,
      });
      if (result.kind === "nonpristine_operator_store_missing") {
        return { kind: "operator_store_missing_nonpristine" };
      }
      if (result.kind !== "completed") return result;
      disabled = true;
      await input.afterCompleted();
      return result;
    },
    async status() {
      return disabled
        ? ({ kind: "disabled" } as const)
        : ({ candidateHash: input.candidateHash, kind: "required" } as const);
    },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}
