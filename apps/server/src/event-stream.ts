import type { EventRecord } from "@symphony/contracts";

export function encodeServerSentEvent(record: EventRecord): string {
  return `id: ${record.cursor}\nevent: symphony.event\ndata: ${JSON.stringify(record)}\n\n`;
}

export function resolveEventResumeCursor(input: {
  explicit: string | undefined;
  lastEventId: string | undefined;
}): number {
  const value = input.explicit ?? input.lastEventId;
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("events.invalid_cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("events.invalid_cursor");
  return cursor;
}
