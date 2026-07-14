import type { EventRecord } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface AppendEventRecordInput {
  attemptId: string | null;
  changeClass: "trivial" | "standard" | "high_risk" | null;
  computeProfile: "economy" | "standard" | "deep" | null;
  costUsd: number | null;
  eventName: string;
  id: string;
  payload: Readonly<Record<string, unknown>>;
  reasonCode: string;
  result: string;
  serviceRunId: string;
  timestamp: string;
  workRef: { issue_id: string } | { system_job_id: string } | null;
}

interface EventRow {
  attempt_id: string | null;
  change_class: "trivial" | "standard" | "high_risk" | null;
  compute_profile: "economy" | "standard" | "deep" | null;
  cost_usd: number | null;
  cursor: number;
  event_name: string;
  id: string;
  payload_json: string;
  reason_code: string;
  result: string;
  service_run_id: string;
  timestamp: string;
  work_ref_id: string | null;
  work_ref_kind: "issue" | "system_job" | null;
}

export async function appendEventRecord(
  database: Kysely<DatabaseSchema>,
  input: AppendEventRecordInput,
): Promise<EventRecord> {
  return appendEventRecordInTransaction(database, input);
}

export async function appendEventRecordInTransaction(
  database: Kysely<DatabaseSchema>,
  input: AppendEventRecordInput,
): Promise<EventRecord> {
  if ((input.attemptId === null) !== (input.computeProfile === null)) {
    throw new Error("events.invalid_attempt_scope");
  }
  if (input.attemptId !== null && input.workRef === null) {
    throw new Error("events.attempt_work_ref_required");
  }
  const work = splitWorkRef(input.workRef);
  const inserted = await sql<{ cursor: number }>`
    insert into event_records (
      id, service_run_id, work_ref_kind, work_ref_id, attempt_id, compute_profile,
      change_class, timestamp, event_name, result, reason_code, cost_usd, payload_json
    ) values (
      ${input.id}, ${input.serviceRunId}, ${work.kind}, ${work.id}, ${input.attemptId},
      ${input.computeProfile}, ${input.changeClass}, ${input.timestamp}, ${input.eventName},
      ${input.result}, ${input.reasonCode}, ${input.costUsd}, ${JSON.stringify(input.payload)}
    ) returning cursor
  `.execute(database);
  const cursor = inserted.rows[0]?.cursor;
  if (cursor === undefined) throw new Error("events.cursor_not_returned");
  return {
    attempt_id: input.attemptId,
    change_class: input.changeClass,
    compute_profile: input.computeProfile,
    cost_usd: input.costUsd,
    cursor,
    event_name: input.eventName,
    id: input.id,
    payload: { ...input.payload },
    reason_code: input.reasonCode,
    result: input.result,
    service_run_id: input.serviceRunId,
    timestamp: input.timestamp,
    work_ref: input.workRef,
  } as EventRecord;
}

export async function listEventRecords(
  database: Kysely<DatabaseSchema>,
  input: { afterCursor: number; limit: number },
): Promise<{ hasMore: boolean; items: EventRecord[]; nextCursor: number }> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new Error("events.invalid_limit");
  }
  if (!Number.isInteger(input.afterCursor) || input.afterCursor < 0) {
    throw new Error("events.invalid_cursor");
  }
  const result = await sql<EventRow>`
    select * from event_records
    where cursor > ${input.afterCursor}
    order by cursor
    limit ${input.limit + 1}
  `.execute(database);
  const hasMore = result.rows.length > input.limit;
  const items = result.rows.slice(0, input.limit).map(mapEventRow);
  return {
    hasMore,
    items,
    nextCursor: items.at(-1)?.cursor ?? input.afterCursor,
  };
}

export async function* streamEventRecords(
  database: Kysely<DatabaseSchema>,
  input: {
    afterCursor: number;
    batchSize: number;
    pollIntervalMs: number;
    signal: AbortSignal;
    wait?: (signal: AbortSignal, intervalMs: number) => Promise<void>;
  },
): AsyncGenerator<EventRecord> {
  let cursor = input.afterCursor;
  const wait = input.wait ?? waitForAbortableDelay;
  while (!input.signal.aborted) {
    const page = await listEventRecords(database, {
      afterCursor: cursor,
      limit: input.batchSize,
    });
    for (const record of page.items) {
      cursor = record.cursor;
      yield record;
      if (input.signal.aborted) return;
    }
    if (page.hasMore) continue;
    await wait(input.signal, input.pollIntervalMs);
  }
}

async function waitForAbortableDelay(signal: AbortSignal, intervalMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function splitWorkRef(workRef: AppendEventRecordInput["workRef"]): {
  id: string | null;
  kind: "issue" | "system_job" | null;
} {
  if (workRef === null) return { id: null, kind: null };
  if ("issue_id" in workRef) return { id: workRef.issue_id, kind: "issue" };
  return { id: workRef.system_job_id, kind: "system_job" };
}

function mapEventRow(row: EventRow): EventRecord {
  const workRef =
    row.work_ref_kind === "issue"
      ? { issue_id: row.work_ref_id as string }
      : row.work_ref_kind === "system_job"
        ? { system_job_id: row.work_ref_id as string }
        : null;
  return {
    attempt_id: row.attempt_id,
    change_class: row.change_class,
    compute_profile: row.compute_profile,
    cost_usd: row.cost_usd,
    cursor: row.cursor,
    event_name: row.event_name,
    id: row.id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    reason_code: row.reason_code,
    result: row.result,
    service_run_id: row.service_run_id,
    timestamp: row.timestamp,
    work_ref: workRef,
  } as EventRecord;
}
