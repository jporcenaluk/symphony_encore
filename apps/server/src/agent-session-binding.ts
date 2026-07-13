import type { AgentAdapter, AgentLaunchRequest, AgentSession } from "@symphony/adapters";
import type { AgentErrorCode, AgentEvent } from "@symphony/contracts";
import type { PersistenceSafetyController } from "@symphony/orchestration";
import { type OpenedDatabase, startLiveAttemptSession } from "@symphony/persistence";

type SessionStartedEvent = AgentEvent & {
  event: "session_started";
  model: string;
  reasoning_effort: string;
  thread_id: string;
  turn_id: string;
};

export interface BoundAgentSession {
  events: AsyncIterable<AgentEvent>;
  session: AgentSession;
  started: SessionStartedEvent;
}

export async function launchAndBindAgentSession(input: {
  adapter: AgentAdapter;
  database: OpenedDatabase["database"];
  request: AgentLaunchRequest;
  safety: PersistenceSafetyController;
}): Promise<BoundAgentSession> {
  const session = await input.adapter.launch(input.request);
  const iterator = session.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    await cancelBestEffort(session, "result_missing");
    throw new Error("agent.session_started_missing");
  }
  const event = first.value;
  if (isStartupFailed(event)) {
    await cancelBestEffort(session, "startup_failed");
    throw new Error(`agent.startup_failed:${event.error_code}`);
  }
  const profile = input.request.preflight.manifest.profiles[input.request.profile];
  if (
    !isSessionStarted(event) ||
    event.attempt_id !== input.request.attemptId ||
    event.session_id === null ||
    event.model !== profile.model ||
    event.reasoning_effort !== profile.reasoning_effort
  ) {
    await cancelBestEffort(session, "protocol_incompatible");
    throw new Error("agent.session_started_invalid");
  }
  try {
    await startLiveAttemptSession(input.database, {
      adapter_version: input.request.preflight.adapterVersion,
      attempt_id: input.request.attemptId,
      last_event: event.event,
      last_event_at: event.timestamp,
      last_input_tokens: 0,
      last_output_tokens: 0,
      last_total_tokens: 0,
      ownership_verified_at: null,
      process_group_id: session.processGroupId,
      process_id: session.processId,
      protocol_schema_hash: input.request.preflight.protocolSchemaHash,
      session_id: event.session_id,
      thread_id: event.thread_id,
      turn_count: 1,
      turn_id: event.turn_id,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      await input.safety.recordFailure(failure);
    } finally {
      await cancelBestEffort(session, "persistence_failure");
    }
    throw failure;
  }
  return {
    events: {
      [Symbol.asyncIterator]() {
        return iterator;
      },
    },
    session,
    started: event,
  };
}

async function cancelBestEffort(session: AgentSession, reason: string): Promise<void> {
  try {
    await session.cancel(reason);
  } catch {
    // The adapter's process-group teardown remains authoritative.
  }
}

function isStartupFailed(
  event: AgentEvent,
): event is AgentEvent & { error_code: AgentErrorCode; event: "startup_failed" } {
  return event.event === "startup_failed" && "error_code" in event;
}

function isSessionStarted(event: AgentEvent): event is SessionStartedEvent {
  return (
    event.event === "session_started" &&
    "model" in event &&
    "reasoning_effort" in event &&
    "thread_id" in event &&
    "turn_id" in event
  );
}
