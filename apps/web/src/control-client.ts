import { createControlApiClient } from "@symphony/contracts";

const baseUrl = typeof window === "undefined" ? "http://127.0.0.1:8080" : window.location.origin;

export const controlClient = createControlApiClient(baseUrl);
