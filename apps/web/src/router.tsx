import {
  createBrowserHistory,
  type createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { useOperatorSession } from "./api-session.js";
import { ConsoleShell } from "./console-shell.js";
import { controlClient } from "./control-client.js";
import { OperationsView } from "./operations-view.js";
import { queryErrorCode, useControlState, useDurableEvents } from "./query-hooks.js";
import { SettingsView } from "./settings-view.js";

const rootRoute = createRootRoute({ component: ConsoleShell });

const indexRoute = createRoute({
  beforeLoad: () => {
    throw redirect({ to: "/operations" });
  },
  getParentRoute: () => rootRoute,
  path: "/",
});

const operationsRoute = createRoute({
  component: OperationsRoute,
  getParentRoute: () => rootRoute,
  path: "/operations",
});

const historyRoute = createRoute({
  component: () => (
    <PlaceholderSurface eyebrow="Durable evidence" heading="Issue and run history" />
  ),
  getParentRoute: () => rootRoute,
  path: "/history",
});

const settingsRoute = createRoute({
  component: SettingsRoute,
  getParentRoute: () => rootRoute,
  path: "/settings",
});

const routeTree = rootRoute.addChildren([indexRoute, operationsRoute, historyRoute, settingsRoute]);

type ConsoleHistory =
  | ReturnType<typeof createMemoryHistory>
  | ReturnType<typeof createBrowserHistory>;

export function createConsoleRouter(history: ConsoleHistory = createBrowserHistory()) {
  return createRouter({ history, routeTree });
}

function PlaceholderSurface({ eyebrow, heading }: { eyebrow: string; heading: string }) {
  return (
    <section className="surface placeholder-surface">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{heading}</h1>
      <p>Resource projection is being connected to the authenticated Control API.</p>
    </section>
  );
}

function OperationsRoute() {
  const state = useControlState(controlClient);
  const events = useDurableEvents(controlClient);
  if (state.data === undefined || events.data === undefined) {
    return (
      <section className="surface pending-surface" aria-labelledby="pending-operations-heading">
        <p className="eyebrow">Live control state</p>
        <h1 id="pending-operations-heading">Operations</h1>
        <p>Loading confirmed durable state…</p>
        {state.error || events.error ? (
          <div className="error-panel" role="alert">
            {queryErrorCode(state.error) ?? queryErrorCode(events.error)}
          </div>
        ) : null}
      </section>
    );
  }
  return (
    <OperationsView
      events={events.data}
      eventsError={queryErrorCode(events.error)}
      stale={state.isStale || events.isStale}
      state={state.data}
      stateError={queryErrorCode(state.error)}
    />
  );
}

function SettingsRoute() {
  const { session } = useOperatorSession();
  if (session === null) return null;
  return (
    <SettingsView
      csrfToken={session.csrfToken}
      mutateConfigurationOverride={controlClient.mutateConfigurationOverride}
    />
  );
}
