/**
 * Generated from the registered Control API OpenAPI document.
 * Do not edit by hand; run `pnpm openapi:generate`.
 */
import type { ControlState, ErrorEnvelope, HealthResponse, ReadyResponse } from "./control-api.js";

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
  getControlState(): Promise<ControlState>;
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
    getControlState: () => request<ControlState>("/api/v1/state", "GET"),
  };
}
