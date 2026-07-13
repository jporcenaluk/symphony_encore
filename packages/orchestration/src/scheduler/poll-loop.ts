export class PollLoop {
  private active: Promise<void> | null = null;
  private queued = false;
  private readonly runTick: () => Promise<unknown>;

  constructor(runTick: () => Promise<unknown>) {
    this.runTick = runTick;
  }

  trigger(): Promise<void> {
    this.queued = true;
    if (!this.active) {
      this.active = this.drain().finally(() => {
        this.active = null;
      });
    }
    return this.active;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  private async drain(): Promise<void> {
    while (this.queued) {
      this.queued = false;
      await this.runTick();
    }
  }
}
