export interface WaitForHttpReadyOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export async function waitForHttpReady(
  url: string,
  options: WaitForHttpReadyOptions = {},
): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const pollMs = boundedDuration(options.pollMs ?? 50, "runtime readiness poll");
  const timeoutMs = boundedDuration(options.timeoutMs ?? 15_000, "runtime readiness timeout");
  const deadline = Date.now() + timeoutMs;
  let lastResponse = "no response";

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`runtime readiness timed out: ${lastResponse}`);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`runtime readiness timed out: ${lastResponse}`));
        }, remainingMs);
        timer.unref();
      });
      const response = await Promise.race([
        fetchImplementation(`${url}/ready`, { signal: controller.signal }),
        timeout,
      ]);
      const body = await Promise.race([response.text(), timeout]);
      lastResponse = `${response.status} ${body.slice(0, 2_000)}`;
      if (response.status === 200) return;
      if (response.status !== 503) {
        throw new Error(`runtime readiness returned an unexpected response: ${lastResponse}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
  }
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
