import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createComponentLogger, createRootLogger } from "./logger.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  records(): Record<string, unknown>[] {
    return Buffer.concat(this.chunks)
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe("structured process logger", () => {
  it("emits newline-delimited JSON with stable component and work bindings", () => {
    const destination = new Capture();
    const root = createRootLogger({ destination, level: "info" });
    const logger = createComponentLogger(root, "tracker", {
      project_id: "project-1",
      service_run_id: "run-1",
      work_ref: "issue:123",
    });

    logger.info(
      { event_name: "tracker.fetch", reason_code: "tick.candidate_refresh", result: "succeeded" },
      "candidate refresh completed",
    );

    expect(destination.records()).toEqual([
      expect.objectContaining({
        component: "tracker",
        event_name: "tracker.fetch",
        level: 30,
        msg: "candidate refresh completed",
        project_id: "project-1",
        reason_code: "tick.candidate_refresh",
        result: "succeeded",
        service_run_id: "run-1",
        work_ref: "issue:123",
      }),
    ]);
  });

  it("recursively redacts fixed secret-bearing fields while retaining bounded metadata", () => {
    const destination = new Capture();
    const logger = createRootLogger({ destination, level: "info" });

    logger.info({
      changed_file_count: 3,
      csrfToken: "csrf-secret",
      nested: {
        credential: "provider-secret",
        headers: { authorization: "Bearer secret", cookie: "session=secret" },
        prompt: "full private prompt",
        prompt_hash: "sha256:safe",
        raw_diff: "private patch",
      },
      password: "local-secret",
      safe_url: "https://example.test/issues/1",
      session_secret: "$SESSION_SECRET",
    });

    expect(destination.records()[0]).toMatchObject({
      changed_file_count: 3,
      csrfToken: "[Redacted]",
      nested: {
        credential: "[Redacted]",
        headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
        prompt: "[Redacted]",
        prompt_hash: "sha256:safe",
        raw_diff: "[Redacted]",
      },
      password: "[Redacted]",
      safe_url: "https://example.test/issues/1",
      session_secret: "[Redacted]",
    });
  });
});
