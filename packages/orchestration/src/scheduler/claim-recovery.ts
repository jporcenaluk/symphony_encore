import type { Claim } from "@symphony/contracts";

export interface ClaimRecoverySnapshot {
  awaitingHuman: readonly Claim[];
  ready: readonly Claim[];
  retries: ReadonlyArray<{ claim: Claim; delayMs: number }>;
  running: ReadonlyArray<{ claim: Claim; expired: boolean }>;
}

export interface ClaimRecoveryPorts {
  enqueueReady(claim: Claim): Promise<unknown>;
  recoverRunning(entry: { claim: Claim; expired: boolean }): Promise<unknown>;
  registerAwaitingHuman(claim: Claim): Promise<unknown>;
  scheduleRetry(claim: Claim, delayMs: number): Promise<unknown>;
}

export async function rehydrateClaims(
  snapshot: ClaimRecoverySnapshot,
  ports: ClaimRecoveryPorts,
): Promise<void> {
  for (const entry of snapshot.running) await ports.recoverRunning(entry);
  for (const claim of snapshot.ready) await ports.enqueueReady(claim);
  for (const retry of snapshot.retries) await ports.scheduleRetry(retry.claim, retry.delayMs);
  for (const claim of snapshot.awaitingHuman) await ports.registerAwaitingHuman(claim);
}
