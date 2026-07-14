/**
 * Generated from the registered Control API OpenAPI document.
 * Do not edit by hand; run `pnpm openapi:generate`.
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
  completeBootstrap(input: BootstrapRequest): Promise<BootstrapResponse>;
  getBootstrapStatus(): Promise<BootstrapStatusResponse>;
  getControlState(): Promise<ControlState>;
  getHealth(): Promise<HealthResponse>;
  getReady(): Promise<ReadyResponse>;
  listEvents(input?: { afterCursor?: number; limit?: number }): Promise<EventRecordPage>;
  login(input: LoginRequest): Promise<LoginResponse>;
  mutateConfigurationOverride(
    key: string,
    input: ConfigurationOverrideMutation,
    csrfToken: string,
  ): Promise<ConfigurationOverrideMutationResponse>;
  streamEvents(input?: { afterCursor?: number }): ControlEventStreamRequest;
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
  const request = async <T>(
    operationPath: string,
    method: string,
    body?: unknown,
    csrfToken?: string,
  ): Promise<T> => {
    const response = await fetchImplementation(`${normalizedBaseUrl}${operationPath}`, {
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
    completeBootstrap: (input) => request<BootstrapResponse>("/api/v1/bootstrap", "POST", input),
    getBootstrapStatus: () => request<BootstrapStatusResponse>("/api/v1/bootstrap", "GET"),
    getControlState: () => request<ControlState>("/api/v1/state", "GET"),
    getHealth: () => request<HealthResponse>("/health", "GET"),
    getReady: () => request<ReadyResponse>("/ready", "GET"),
    listEvents: (input = {}) => {
      const query = new URLSearchParams();
      if (input.afterCursor !== undefined) query.set("after_cursor", String(input.afterCursor));
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size === 0 ? "" : `?${query}`;
      return request<EventRecordPage>(`/api/v1/events${suffix}`, "GET");
    },
    login: (input) => request<LoginResponse>("/api/v1/auth/login", "POST", input),
    mutateConfigurationOverride: (key, input, csrfToken) =>
      request<ConfigurationOverrideMutationResponse>(
        `/api/v1/config/overrides/${encodeURIComponent(key)}`,
        "PUT",
        input,
        csrfToken,
      ),
    streamEvents: (input = {}) => {
      const suffix = input.afterCursor === undefined ? "" : `?after_cursor=${input.afterCursor}`;
      return {
        url: `${normalizedBaseUrl}/api/v1/events/stream${suffix}`,
        withCredentials: true as const,
      };
    },
  };
}
