import {
  listEventRecords,
  type OpenedDatabase,
  readControlState,
  readServiceStatus,
  streamEventRecords,
} from "@symphony/persistence";

import {
  type ControlApi,
  type ControlApiDependencies,
  createControlApi,
  type OperatorPrincipal,
} from "./control-api.js";

export interface PersistentControlApiInput {
  authenticate: ControlApiDependencies["authenticate"];
  database: OpenedDatabase["database"];
  login: ControlApiDependencies["login"];
  sessionCookieSecure: boolean;
}

export async function createPersistentControlApi(input: PersistentControlApiInput) {
  return createControlApi({
    authenticate: input.authenticate,
    login: input.login,
    async listEvents(page) {
      const result = await listEventRecords(input.database, page);
      return {
        has_more: result.hasMore,
        items: result.items,
        next_cursor: result.nextCursor,
      };
    },
    readControlState: () => readControlState(input.database),
    readServiceStatus: () => readServiceStatus(input.database),
    sessionCookieSecure: input.sessionCookieSecure,
    streamEvents: ({ afterCursor, signal }) =>
      streamEventRecords(input.database, {
        afterCursor,
        batchSize: 100,
        pollIntervalMs: 250,
        signal,
      }),
  });
}

export type { ControlApi, OperatorPrincipal };
