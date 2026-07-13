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
    async login() {
      return null;
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

const OPERATION_RETURN_TYPES: Readonly<Record<string, string>> = {
  getControlState: "ControlState",
  getHealth: "HealthResponse",
  getReady: "ReadyResponse",
  login: "LoginResponse",
  listEvents: "EventRecordPage",
  streamEvents: "ControlEventStreamRequest",
};

export async function renderControlApiClient(): Promise<string> {
  const document = await buildOpenApiDocument();
  const operations: { method: string; operationId: string; path: string; returnType: string }[] =
    [];
  for (const [operationPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === undefined) continue;
      const returnType = OPERATION_RETURN_TYPES[operation.operationId];
      if (returnType === undefined) {
        throw new Error(`openapi.unsupported_operation:${operation.operationId}`);
      }
      operations.push({
        method: method.toUpperCase(),
        operationId: operation.operationId,
        path: operationPath,
        returnType,
      });
    }
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
      return `    ${operation.operationId}: () => request<${operation.returnType}>(${JSON.stringify(operation.path)}, ${JSON.stringify(operation.method)}),`;
    })
    .join("\n");
  return `/**
 * Generated from the registered Control API OpenAPI document.
 * Do not edit by hand; run \`pnpm openapi:generate\`.
 */
import type {
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
${operations.map((operation) => (operation.operationId === "listEvents" ? "  listEvents(input?: { afterCursor?: number; limit?: number }): Promise<EventRecordPage>;" : operation.operationId === "streamEvents" ? "  streamEvents(input?: { afterCursor?: number }): ControlEventStreamRequest;" : operation.operationId === "login" ? "  login(input: LoginRequest): Promise<LoginResponse>;" : `  ${operation.operationId}(): Promise<${operation.returnType}>;`)).join("\n")}
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
  const request = async <T>(operationPath: string, method: string, body?: unknown): Promise<T> => {
    const response = await fetchImplementation(\`\${normalizedBaseUrl}\${operationPath}\`, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
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
