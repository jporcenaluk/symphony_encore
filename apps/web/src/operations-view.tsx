import type { ControlState, EventRecord, EventRecordPage } from "@symphony/contracts";
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useMemo } from "react";

export function OperationsView({
  events,
  eventsError,
  stale,
  state,
  stateError,
}: {
  events: EventRecordPage;
  eventsError: string | null;
  stale: boolean;
  state: ControlState;
  stateError: string | null;
}) {
  const columns = useMemo<ColumnDef<EventRecord>[]>(
    () => [
      {
        accessorKey: "cursor",
        header: "Cursor",
      },
      {
        accessorKey: "timestamp",
        cell: ({ getValue }) => (
          <time dateTime={getValue<string>()}>{formatTime(getValue<string>())}</time>
        ),
        header: "Observed",
      },
      { accessorKey: "event_name", header: "Event" },
      { accessorKey: "reason_code", header: "Reason" },
      { accessorKey: "result", header: "Result" },
      {
        accessorKey: "payload",
        cell: ({ getValue }) => <code>{JSON.stringify(getValue<Record<string, unknown>>())}</code>,
        header: "Durable payload",
      },
    ],
    [],
  );
  const table = useReactTable({
    columns,
    data: events.items,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <section className="surface operations-surface" aria-labelledby="operations-heading">
      <header className="surface-heading">
        <div>
          <p className="eyebrow">Live control state</p>
          <h1 id="operations-heading">Operations</h1>
        </div>
        <span className={`run-state ${state.service_run.status}`}>
          {state.service_run.status.toUpperCase()}
        </span>
      </header>

      {stale ? (
        <div className="stale-banner" role="status">
          Confirmed data may be stale
        </div>
      ) : null}
      {stateError || eventsError ? (
        <div className="error-panel" role="alert">
          <strong>Control API refresh failed</strong>
          {stateError ? <span>{stateError}</span> : null}
          {eventsError ? <span>{eventsError}</span> : null}
        </div>
      ) : null}

      <section className="metric-grid" aria-label="Service control gates">
        <article>
          <span>ServiceRun</span>
          <strong>{state.service_run.id}</strong>
          <small>v{state.service_run.service_version}</small>
        </article>
        <article>
          <span>Dispatch</span>
          <strong>{state.dispatch_enabled ? "Dispatch enabled" : "Dispatch held"}</strong>
          <small>durable scheduler gate</small>
        </article>
        <article>
          <span>Mutations</span>
          <strong>{state.mutations_enabled ? "Mutations enabled" : "Mutations held"}</strong>
          <small>privileged control gate</small>
        </article>
        <article>
          <span>State version</span>
          <strong>{state.version}</strong>
          <small>confirmed projection</small>
        </article>
      </section>

      <div className="section-grid">
        <section className="data-panel events-panel" aria-labelledby="events-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Append-only timeline</p>
              <h2 id="events-heading">Latest durable events</h2>
            </div>
            <span>cursor {events.next_cursor}</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => (
                      <th key={header.id} scope="col">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="data-panel unavailable-panel" aria-labelledby="unavailable-heading">
          <p className="eyebrow">Projection boundary</p>
          <h2 id="unavailable-heading">Resource unavailable</h2>
          <p>Issues, attempts, queues, and budgets require additional API resources.</p>
          <small>No zero values are inferred while those durable reads are absent.</small>
        </aside>
      </div>
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(11, 19);
}
