import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { type OperatorSession, SessionProvider } from "./api-session.js";
import type { createConsoleRouter } from "./router.js";

export function App({
  initialSession = null,
  queryClient,
  router,
}: {
  initialSession?: OperatorSession | null;
  queryClient: QueryClient;
  router: ReturnType<typeof createConsoleRouter>;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider initialSession={initialSession}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
