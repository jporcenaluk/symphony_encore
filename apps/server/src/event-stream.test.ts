import type { EventRecord } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { encodeServerSentEvent, resolveEventResumeCursor } from "./event-stream.js";

const record: EventRecord = {
  attempt_id: null,
  change_class: null,
  compute_profile: null,
  cost_usd: null,
  cursor: 12,
  event_name: "hostile\nevent",
  id: "event-12",
  payload: { message: "line one\nline two" },
  reason_code: "event.recorded",
  result: "recorded",
  service_run_id: "run-1",
  timestamp: "2026-07-13T10:00:12Z",
  work_ref: null,
};

describe("durable SSE framing", () => {
  it("uses only the durable cursor in control lines and JSON-escapes untrusted content", () => {
    const encoded = encodeServerSentEvent(record);
    expect(encoded).toBe(`id: 12\nevent: symphony.event\ndata: ${JSON.stringify(record)}\n\n`);
    expect(encoded).not.toContain("event: hostile");
  });

  it("resumes from an explicit cursor or Last-Event-ID and rejects malformed values", () => {
    expect(resolveEventResumeCursor({ explicit: "8", lastEventId: "7" })).toBe(8);
    expect(resolveEventResumeCursor({ explicit: undefined, lastEventId: "7" })).toBe(7);
    expect(resolveEventResumeCursor({ explicit: undefined, lastEventId: undefined })).toBe(0);
    expect(() => resolveEventResumeCursor({ explicit: "-1", lastEventId: undefined })).toThrow(
      "events.invalid_cursor",
    );
  });
});
