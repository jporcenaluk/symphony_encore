import type { ControlState, EventRecordPage } from "@symphony/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OperationsView } from "./operations-view.js";

const state: ControlState = {
  dispatch_enabled: true,
  mutations_enabled: true,
  service_run: {
    id: "run-1",
    service_version: "1.2.3",
    started_at: "2026-07-13T10:00:00Z",
    status: "ready",
  },
  version: "service-run:run-1:ready",
};

const events: EventRecordPage = {
  has_more: false,
  items: [
    {
      attempt_id: null,
      change_class: null,
      compute_profile: null,
      cost_usd: null,
      cursor: 9,
      event_name: "issue.observed",
      id: "event-9",
      payload: { title: "<script>alert('hostile')</script>" },
      reason_code: "tracker.refresh",
      result: "recorded",
      service_run_id: "run-1",
      timestamp: "2026-07-13T10:01:00Z",
      work_ref: { issue_id: "issue-1" },
    },
  ],
  next_cursor: 9,
};

describe("operations surface", () => {
  it("renders only confirmed control state and labels unavailable resource breadth", () => {
    const markup = renderToStaticMarkup(
      <OperationsView
        events={events}
        eventsError={null}
        stale={false}
        state={state}
        stateError={null}
      />,
    );

    expect(markup).toContain("Live control state");
    expect(markup).toContain("READY");
    expect(markup).toContain("Dispatch enabled");
    expect(markup).toContain("Mutations enabled");
    expect(markup).toContain("service-run:run-1:ready");
    expect(markup).toContain("issue.observed");
    expect(markup).toContain("Resource unavailable");
    expect(markup).toContain(
      "Issues, attempts, queues, and budgets require additional API resources.",
    );
    expect(markup).toContain("&lt;script&gt;alert(&#x27;hostile&#x27;)&lt;/script&gt;");
    expect(markup).not.toContain("<script>alert");
  });

  it("keeps confirmed data visible beside stale and refetch errors", () => {
    const markup = renderToStaticMarkup(
      <OperationsView
        events={events}
        eventsError="events.request_failed"
        stale
        state={state}
        stateError="state.request_failed"
      />,
    );

    expect(markup).toContain("Confirmed data may be stale");
    expect(markup).toContain("state.request_failed");
    expect(markup).toContain("events.request_failed");
    expect(markup).toContain("READY");
  });
});
