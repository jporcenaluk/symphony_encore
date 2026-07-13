import {
  listEventRecords,
  type OpenedDatabase,
  readControlState,
  readServiceStatus,
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
}

export async function createPersistentControlApi(input: PersistentControlApiInput) {
  return createControlApi({
    authenticate: input.authenticate,
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
  });
}

export type { ControlApi, OperatorPrincipal };
