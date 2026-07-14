import type { ControlApiClient } from "@symphony/contracts";
import { useQuery } from "@tanstack/react-query";

export function useControlState(client: ControlApiClient) {
  return useQuery({
    queryFn: () => client.getControlState(),
    queryKey: ["control-state"],
    refetchInterval: 5_000,
    staleTime: 5_000,
  });
}

export function useDurableEvents(client: ControlApiClient) {
  return useQuery({
    queryFn: () => client.listEvents({ limit: 50 }),
    queryKey: ["events", { limit: 50 }],
    refetchInterval: 2_000,
    staleTime: 2_000,
  });
}

export function queryErrorCode(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "object" && "envelope" in error) {
    const envelope = error.envelope;
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "error" in envelope &&
      typeof envelope.error === "object" &&
      envelope.error !== null &&
      "code" in envelope.error &&
      typeof envelope.error.code === "string"
    ) {
      return envelope.error.code;
    }
  }
  return "control_api.request_failed";
}
