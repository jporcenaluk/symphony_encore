/**
 * Generated from the registered Control API OpenAPI document.
 * Do not edit by hand; run `pnpm openapi:generate`.
 */
import type {
  ControlState,
  ErrorEnvelope,
  EventRecordPage,
  HealthResponse,
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
  getHealth(): Promise<HealthResponse>;
  getReady(): Promise<ReadyResponse>;
  streamEvents(input?: { afterCursor?: number }): ControlEventStreamRequest;
  listEvents(input?: { afterCursor?: number; limit?: number }): Promise<EventRecordPage>;
  getControlState(): Promise<ControlState>;
}

export interface ControlEventStreamRequest {
  url: string;
  withCredentials: true;
}

export function createControlApiClient(
  baseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): ControlApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, "");
  const request = async <T>(operationPath: string, method: string): Promise<T> => {
    const response = await fetchImplementation(`${normalizedBaseUrl}${operationPath}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method,
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new ControlApiClientError(response.status, payload as ErrorEnvelope);
    return payload as T;
  };
  return {
    getHealth: () => request<HealthResponse>("/health", "GET"),
    getReady: () => request<ReadyResponse>("/ready", "GET"),
    streamEvents: (input = {}) => {
      const suffix = input.afterCursor === undefined ? "" : `?after_cursor=${input.afterCursor}`;
      return {
        url: `${normalizedBaseUrl}/api/v1/events/stream${suffix}`,
        withCredentials: true as const,
      };
    },
    listEvents: (input = {}) => {
      const query = new URLSearchParams();
      if (input.afterCursor !== undefined) query.set("after_cursor", String(input.afterCursor));
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size === 0 ? "" : `?${query}`;
      return request<EventRecordPage>(`/api/v1/events${suffix}`, "GET");
    },
    getControlState: () => request<ControlState>("/api/v1/state", "GET"),
  };
}
