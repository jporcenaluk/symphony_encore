import { createHash, randomUUID } from "node:crypto";
import {
  listEventRecords,
  type OpenedDatabase,
  mutateConfigurationOverride as persistConfigurationOverride,
  readControlState,
  readServiceStatus,
  streamEventRecords,
} from "@symphony/persistence";
import type { FastifyBaseLogger } from "fastify";
import {
  type ControlApi,
  type ControlApiDependencies,
  createControlApi,
  type OperatorPrincipal,
} from "./control-api.js";

export interface PersistentControlApiInput {
  authenticate: ControlApiDependencies["authenticate"];
  authenticateMutation: ControlApiDependencies["authenticateMutation"];
  bootstrap?: ControlApiDependencies["bootstrap"];
  database: OpenedDatabase["database"];
  login: ControlApiDependencies["login"];
  logger?: FastifyBaseLogger;
  newActionId?: () => string;
  now?: () => string;
  readControlState?: ControlApiDependencies["readControlState"];
  readServiceStatus?: ControlApiDependencies["readServiceStatus"];
  sessionCookieSecure: boolean;
  validateConfigurationOverride(input: {
    key: string;
    operation: "set" | "clear";
    value?: unknown;
  }): string | null;
}

export async function createPersistentControlApi(input: PersistentControlApiInput) {
  return createControlApi({
    authenticate: input.authenticate,
    authenticateMutation: input.authenticateMutation,
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    login: input.login,
    ...(input.logger ? { logger: input.logger } : {}),
    async mutateConfigurationOverride(request) {
      const requestPayloadHash = hashCanonical({
        expectedVersion: request.expectedVersion,
        key: request.key,
        operation: request.operation,
        reason: request.reason,
        ...(request.operation === "set" ? { value: request.value } : {}),
      });
      return persistConfigurationOverride(input.database, {
        actionId: input.newActionId?.() ?? randomUUID(),
        authSubject: request.operator.authSubject,
        capability: "config.write",
        createdAt: input.now?.() ?? new Date().toISOString(),
        endpoint: "/api/v1/config/overrides",
        expectedVersion: request.expectedVersion,
        idempotencyKey: request.idempotencyKey,
        key: request.key,
        operation: request.operation,
        operatorId: request.operator.operatorId,
        reason: request.reason,
        requestPayloadHash,
        validationError: input.validateConfigurationOverride({
          key: request.key,
          operation: request.operation,
          ...(request.operation === "set" ? { value: request.value } : {}),
        }),
        value: request.operation === "set" ? request.value : null,
      });
    },
    async listEvents(page) {
      const result = await listEventRecords(input.database, page);
      return {
        has_more: result.hasMore,
        items: result.items,
        next_cursor: result.nextCursor,
      };
    },
    readControlState: input.readControlState ?? (() => readControlState(input.database)),
    readServiceStatus: input.readServiceStatus ?? (() => readServiceStatus(input.database)),
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

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
}

export type { ControlApi, OperatorPrincipal };
