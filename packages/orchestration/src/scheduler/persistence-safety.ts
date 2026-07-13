export class PersistenceSafetyController {
  private latchedFailure: Error | null = null;
  private readonly stopWorkers: (failure: Error) => Promise<void>;
  private stopPromise: Promise<void> | null = null;

  constructor(stopWorkers: (failure: Error) => Promise<void>) {
    this.stopWorkers = stopWorkers;
  }

  canDispatch(): boolean {
    return this.latchedFailure === null;
  }

  canMutateProvider(): boolean {
    return this.latchedFailure === null;
  }

  failure(): Error | null {
    return this.latchedFailure;
  }

  async recordFailure(error: Error): Promise<void> {
    if (!this.latchedFailure) {
      this.latchedFailure = error;
      this.stopPromise = this.stopWorkers(error);
    }
    await this.stopPromise;
  }

  assertDispatchAllowed(): void {
    this.assertHealthy();
  }

  assertProviderMutationAllowed(): void {
    this.assertHealthy();
  }

  private assertHealthy(): void {
    if (this.latchedFailure) {
      throw new Error("persistence.failure_latched", { cause: this.latchedFailure });
    }
  }
}
