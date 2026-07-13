import { type OpenedDatabase, readControlState, readServiceStatus } from "@symphony/persistence";

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
    readControlState: () => readControlState(input.database),
    readServiceStatus: () => readServiceStatus(input.database),
  });
}

export type { ControlApi, OperatorPrincipal };
