import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "./api-session.js";
import { createConsoleRouter } from "./router.js";

describe("operator console routes", () => {
  it.each([
    ["/operations", "Operations", "Live control state"],
    ["/history", "History", "Issue and run history"],
    ["/settings", "Settings", "Settings and controls"],
  ])("owns the selected surface in the URL", async (path, navigationLabel, heading) => {
    const router = createConsoleRouter(createMemoryHistory({ initialEntries: [path] }));
    await router.load();

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          initialSession={{
            csrfToken: "csrf",
            expiresAt: "2026-07-13T11:00:00Z",
            operator: {
              auth_subject: "local:admin",
              capabilities: ["operator.read"],
              operator_id: "operator-1",
            },
          }}
        >
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    expect(markup).toContain(`>${navigationLabel}</a>`);
    expect(markup).toContain(heading);
    expect(markup).toContain('aria-current="page"');
  });
});
