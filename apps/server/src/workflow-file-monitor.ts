import { createHash } from "node:crypto";

export interface WorkflowFileMonitor {
  check(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkflowFileMonitorInput {
  initialSourceHash: string;
  intervalMs: number;
  onCandidate(candidate: { source: string; sourceHash: string }): Promise<void>;
  onReadError(error: unknown): void;
  readSource(): Promise<string>;
  startTimer?: boolean;
}

export function createWorkflowFileMonitor(input: WorkflowFileMonitorInput): WorkflowFileMonitor {
  let closed = false;
  let lastObservedHash = input.initialSourceHash;
  let running: Promise<void> | undefined;

  async function runCheck(): Promise<void> {
    let source: string;
    try {
      source = await input.readSource();
    } catch (error) {
      input.onReadError(error);
      return;
    }
    const sourceHash = sha256(source);
    if (sourceHash === lastObservedHash) return;
    lastObservedHash = sourceHash;
    await input.onCandidate({ source, sourceHash });
  }

  function check(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = runCheck().finally(() => {
      running = undefined;
    });
    return running;
  }

  const timer =
    input.startTimer === false
      ? undefined
      : setInterval(() => {
          void check().catch(input.onReadError);
        }, input.intervalMs);
  timer?.unref();

  return {
    check,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
