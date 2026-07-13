import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createControlApi } from "../apps/server/src/control-api.ts";

export const GENERATED_OPENAPI_PATH = path.resolve(
  "packages/contracts/generated/control-api.openapi.json",
);
export const GENERATED_CONTROL_API_CLIENT_PATH = path.resolve(
  "packages/contracts/src/control-api-client.generated.ts",
);

interface OpenApiDocument {
  paths?: Record<string, Record<string, { operationId?: string }>>;
}

export async function renderOpenApi(): Promise<string> {
  return `${JSON.stringify(await buildOpenApiDocument(), null, 2)}\n`;
}

async function buildOpenApiDocument(): Promise<OpenApiDocument> {
  const server = await createControlApi({
    async authenticate() {
      return null;
    },
    async authenticateMutation() {
      return null;
    },
    async login() {
      return null;
    },
    async mutateConfigurationOverride() {
      return { result: "accepted" as const, version: 1 };
    },
    async listEvents() {
      return { has_more: false, items: [], next_cursor: 0 };
    },
    async readControlState() {
      return {
        dispatch_enabled: false,
        mutations_enabled: false,
        service_run: {
          id: "schema-generation",
          service_version: "0.0.0",
          started_at: "1970-01-01T00:00:00Z",
          status: "recovering" as const,
        },
        version: "schema-generation",
      };
    },
    async readServiceStatus() {
      return { id: "schema-generation", state: "recovering" as const };
    },
    sessionCookieSecure: false,
    async *streamEvents() {},
  });
  try {
    await server.ready();
    return server.swagger() as OpenApiDocument;
  } finally {
    await server.close();
  }
}

interface OperationDefinition {
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly returnType: string;
}

const OPERATIONS = {
  completeBootstrap: {
    method: "POST",
    operationId: "completeBootstrap",
    path: "/api/v1/bootstrap",
    returnType: "BootstrapResponse",
  },
  getBootstrapStatus: {
    method: "GET",
    operationId: "getBootstrapStatus",
    path: "/api/v1/bootstrap",
    returnType: "BootstrapStatusResponse",
  },
  getControlState: {
    method: "GET",
    operationId: "getControlState",
    path: "/api/v1/state",
    returnType: "ControlState",
  },
  getHealth: {
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    returnType: "HealthResponse",
  },
  getReady: {
    method: "GET",
    operationId: "getReady",
    path: "/ready",
    returnType: "ReadyResponse",
  },
  listEvents: {
    method: "GET",
    operationId: "listEvents",
    path: "/api/v1/events",
    returnType: "EventRecordPage",
  },
  login: {
    method: "POST",
    operationId: "login",
    path: "/api/v1/auth/login",
    returnType: "LoginResponse",
  },
  mutateConfigurationOverride: {
    method: "PUT",
    operationId: "mutateConfigurationOverride",
    path: "/api/v1/config/overrides/{key}",
    returnType: "ConfigurationOverrideMutationResponse",
  },
  streamEvents: {
    method: "GET",
    operationId: "streamEvents",
    path: "/api/v1/events/stream",
    returnType: "ControlEventStreamRequest",
  },
} as const satisfies Record<string, OperationDefinition>;

export async function renderControlApiClient(): Promise<string> {
  return renderControlApiClientFromDocument(await buildOpenApiDocument());
}

export function renderControlApiClientFromDocument(document: OpenApiDocument): string {
  const operations: OperationDefinition[] = [];
  const seen = new Set<string>();
  for (const [operationPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === undefined) continue;
      const definition = resolveOperationDefinition(operation.operationId);
      if (operationPath !== definition.path || method.toUpperCase() !== definition.method) {
        throw new Error(`openapi.operation_contract_mismatch:${definition.operationId}`);
      }
      if (seen.has(definition.operationId)) {
        throw new Error(`openapi.duplicate_operation:${definition.operationId}`);
      }
      seen.add(definition.operationId);
      operations.push(definition);
    }
  }
  if (seen.size !== Object.keys(OPERATIONS).length) {
    throw new Error("openapi.operation_set_incomplete");
  }

  const methods = operations
    .map((operation) => {
      if (operation.operationId === "listEvents") {
        return `    listEvents: (input = {}) => {
      const query = new URLSearchParams();
      if (input.afterCursor !== undefined) query.set("after_cursor", String(input.afterCursor));
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size === 0 ? "" : \`?\${query}\`;
      return request<EventRecordPage>(\`${operation.path}\${suffix}\`, ${JSON.stringify(operation.method)});
    },`;
      }
      if (operation.operationId === "streamEvents") {
        return `    streamEvents: (input = {}) => {
      const suffix = input.afterCursor === undefined ? "" : \`?after_cursor=\${input.afterCursor}\`;
      return {
        url: \`\${normalizedBaseUrl}${operation.path}\${suffix}\`,
        withCredentials: true as const,
      };
    },`;
      }
      if (operation.operationId === "login") {
        return `    login: (input) => request<LoginResponse>(${JSON.stringify(operation.path)}, ${JSON.stringify(operation.method)}, input),`;
      }
      if (operation.operationId === "completeBootstrap") {
        return `    completeBootstrap: (input) => request<BootstrapResponse>(${JSON.stringify(operation.path)}, ${JSON.stringify(operation.method)}, input),`;
      }
      if (operation.operationId === "mutateConfigurationOverride") {
        return `    mutateConfigurationOverride: (key, input, csrfToken) =>
      request<ConfigurationOverrideMutationResponse>(
        \`/api/v1/config/overrides/\${encodeURIComponent(key)}\`,
        ${JSON.stringify(operation.method)},
        input,
        csrfToken,
      ),`;
      }
      return `    ${operation.operationId}: () => request<${operation.returnType}>(${JSON.stringify(operation.path)}, ${JSON.stringify(operation.method)}),`;
    })
    .join("\n");
  return `/**
 * Generated from the registered Control API OpenAPI document.
 * Do not edit by hand; run \`pnpm openapi:generate\`.
 */
import type {
  BootstrapRequest,
  BootstrapResponse,
  BootstrapStatusResponse,
  ConfigurationOverrideMutation,
  ConfigurationOverrideMutationResponse,
  ControlState,
  ErrorEnvelope,
  EventRecordPage,
  HealthResponse,
  LoginRequest,
  LoginResponse,
  ReadyResponse,
} from "./control-api.js";

export class ControlApiClientError extends Error {
  readonly envelope: ErrorEnvelope;
  readonly status: number;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.envelope = envelope;
    this.status = status;
  }
}

export interface ControlApiClient {
${operations
  .map((operation) =>
    operation.operationId === "listEvents"
      ? "  listEvents(input?: { afterCursor?: number; limit?: number }): Promise<EventRecordPage>;"
      : operation.operationId === "streamEvents"
        ? "  streamEvents(input?: { afterCursor?: number }): ControlEventStreamRequest;"
        : operation.operationId === "login"
          ? "  login(input: LoginRequest): Promise<LoginResponse>;"
          : operation.operationId === "completeBootstrap"
            ? "  completeBootstrap(input: BootstrapRequest): Promise<BootstrapResponse>;"
            : operation.operationId === "mutateConfigurationOverride"
              ? `  mutateConfigurationOverride(
    key: string,
    input: ConfigurationOverrideMutation,
    csrfToken: string,
  ): Promise<ConfigurationOverrideMutationResponse>;`
              : `  ${operation.operationId}(): Promise<${operation.returnType}>;`,
  )
  .join("\n")}
}

export interface ControlEventStreamRequest {
  url: string;
  withCredentials: true;
}

export function createControlApiClient(
  baseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): ControlApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\\/$/u, "");
  const request = async <T>(
    operationPath: string,
    method: string,
    body?: unknown,
    csrfToken?: string,
  ): Promise<T> => {
    const response = await fetchImplementation(\`\${normalizedBaseUrl}\${operationPath}\`, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
      },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new ControlApiClientError(response.status, payload as ErrorEnvelope);
    return payload as T;
  };
  return {
${methods}
  };
}
`;
}

function resolveOperationDefinition(operationId: string): OperationDefinition {
  switch (operationId) {
    case "completeBootstrap":
      return OPERATIONS.completeBootstrap;
    case "getBootstrapStatus":
      return OPERATIONS.getBootstrapStatus;
    case "getControlState":
      return OPERATIONS.getControlState;
    case "getHealth":
      return OPERATIONS.getHealth;
    case "getReady":
      return OPERATIONS.getReady;
    case "listEvents":
      return OPERATIONS.listEvents;
    case "login":
      return OPERATIONS.login;
    case "mutateConfigurationOverride":
      return OPERATIONS.mutateConfigurationOverride;
    case "streamEvents":
      return OPERATIONS.streamEvents;
    default:
      throw new Error(`openapi.unsupported_operation:${operationId}`);
  }
}

export async function checkGeneratedOpenApi(target: string): Promise<boolean> {
  try {
    return (await readFile(target, "utf8")) === (await renderOpenApi());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function writeGeneratedOpenApi(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await renderOpenApi(), "utf8");
}

async function checkGeneratedControlApiClient(target: string): Promise<boolean> {
  try {
    return (await readFile(target, "utf8")) === (await renderControlApiClient());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const openApiCurrent = await checkGeneratedOpenApi(GENERATED_OPENAPI_PATH);
    const clientCurrent = await checkGeneratedControlApiClient(GENERATED_CONTROL_API_CLIENT_PATH);
    if (!openApiCurrent || !clientCurrent) {
      process.stderr.write(
        "Generated OpenAPI/client is stale; run `pnpm openapi:generate` and commit the result.\n",
      );
      process.exitCode = 1;
    }
    return;
  }
  await writeGeneratedOpenApi(GENERATED_OPENAPI_PATH);
  await writeFile(GENERATED_CONTROL_API_CLIENT_PATH, await renderControlApiClient(), "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
