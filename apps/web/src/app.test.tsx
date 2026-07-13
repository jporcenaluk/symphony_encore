import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./app.js";
import { createConsoleRouter } from "./router.js";

describe("operator console application", () => {
  it("renders an authenticated durable route without inventing unavailable values", async () => {
    const router = createConsoleRouter(createMemoryHistory({ initialEntries: ["/operations"] }));
    await router.load();
    const markup = renderToStaticMarkup(
      <App
        initialSession={{
          csrfToken: "csrf",
          expiresAt: "2026-07-13T11:00:00Z",
          operator: {
            auth_subject: "local:admin",
            capabilities: ["operator.read"],
            operator_id: "operator-1",
          },
        }}
        queryClient={new QueryClient()}
        router={router}
      />,
    );

    expect(markup).toContain("Symphony Encore");
    expect(markup).toContain("Operations");
    expect(markup).toContain("Loading confirmed durable state");
    expect(markup).not.toContain("$0.00");
  });
});
