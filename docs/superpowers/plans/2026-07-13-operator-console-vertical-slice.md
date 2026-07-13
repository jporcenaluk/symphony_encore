# Operator Console Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder page with an authenticated console that renders durable service
state and events and submits one non-optimistic configuration override.

**Architecture:** TanStack Router owns the active surface in the URL. TanStack Query owns API state
and invalidation. Focused React views receive typed data from the generated client; no component
copies durable state into a browser store. The first slice uses only existing Control API resources
and labels unavailable breadth explicitly.

**Tech Stack:** React 19, Vite 8, TanStack Router, TanStack Query, TanStack Table, generated Control
API client, Vitest, and CSS.

---

## Task 1: Authenticated client session

**Files:**

- Create: `apps/web/src/api-session.tsx`
- Create: `apps/web/src/login-view.tsx`
- Test: `apps/web/src/login-view.test.tsx`

- [ ] **Step 1: Write the failing login render and submit tests**

Render `LoginView` with an injected async `login` function. Assert that it labels subject and
password fields, preserves invalid submitted values except the password, shows the structured API
error, and calls `onAuthenticated` with the returned CSRF token and operator.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/web/src/login-view.test.tsx`

Expected: FAIL because `login-view.tsx` does not exist.

- [ ] **Step 3: Implement the in-memory authenticated session boundary**

Store only `{csrfToken, operator}` in React context. Keep the opaque session in its HttpOnly cookie.
Submit `{auth_subject, password}` through `client.login`, clear the password after each attempt, and
render `ControlApiClientError.envelope.error` without replacing the submitted subject.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm exec vitest run apps/web/src/login-view.test.tsx && pnpm --filter @symphony/web typecheck`

Expected: PASS.

## Task 2: URL-owned console shell

**Files:**

- Create: `apps/web/src/router.tsx`
- Create: `apps/web/src/console-shell.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/router.test.tsx`

- [ ] **Step 1: Write failing navigation tests**

Create a memory history at `/operations`, `/history`, and `/settings`. Assert that each URL selects
the matching rail item and renders its heading. Assert that an unknown URL redirects to operations.

- [ ] **Step 2: Run the router test and verify RED**

Run: `pnpm exec vitest run apps/web/src/router.test.tsx`

Expected: FAIL because `router.tsx` does not exist.

- [ ] **Step 3: Implement three typed routes and providers**

Create one root layout and three child routes. Mount `QueryClientProvider`, `SessionProvider`, and
`RouterProvider` in `main.tsx`. Use links, not buttons, for navigation and preserve visible focus.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm exec vitest run apps/web/src/router.test.tsx && pnpm --filter @symphony/web typecheck`

Expected: PASS.

## Task 3: Durable operations surface

**Files:**

- Create: `apps/web/src/operations-view.tsx`
- Create: `apps/web/src/query-hooks.ts`
- Test: `apps/web/src/operations-view.test.tsx`

- [ ] **Step 1: Write failing projection tests**

Supply a `ControlState` and `EventRecordPage`. Assert that the view shows the ServiceRun status,
dispatch/mutation gates, durable version, latest events, and an explicit “resource unavailable”
panel for issue counts, attempts, queues, and budgets that the API does not yet expose. Assert that
the stale banner and structured error stay visible.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/web/src/operations-view.test.tsx`

Expected: FAIL because `operations-view.tsx` does not exist.

- [ ] **Step 3: Implement query-owned state and event polling**

Use `client.getControlState()` and `client.listEvents({limit: 50})` in TanStack Query hooks. Derive
display values during render. Never invent zero counts or optimistic service state. Mark data stale
from query timestamps and show refetch failures beside the last confirmed data.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm exec vitest run apps/web/src/operations-view.test.tsx && pnpm --filter @symphony/web typecheck`

Expected: PASS.

## Task 4: Non-optimistic settings control

**Files:**

- Create: `apps/web/src/settings-view.tsx`
- Test: `apps/web/src/settings-view.test.tsx`

- [ ] **Step 1: Write failing mutation-state tests**

Assert that the form submits the exact key, expected version, idempotency key, reason, parsed JSON
value, and session CSRF token. On `409` or `422`, keep the key, value, reason, and structured error
visible. On success, show the committed version and invalidate state queries without displaying the
submitted value as effective configuration.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/web/src/settings-view.test.tsx`

Expected: FAIL because `settings-view.tsx` does not exist.

- [ ] **Step 3: Implement the form and mutation state machine**

Use `useMutation` with `client.mutateConfigurationOverride`. Parse set values as JSON and model
clear as a separate operation. Generate one idempotency key per submission. Preserve failed input;
reset only after an accepted response.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm exec vitest run apps/web/src/settings-view.test.tsx && pnpm --filter @symphony/web typecheck`

Expected: PASS.

## Task 5: Visual system and production proof

**Files:**

- Replace: `apps/web/src/styles.css`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `IMPLEMENTATION_STATUS.md`

- [ ] **Step 1: Add accessibility and hostile-content assertions**

Assert semantic landmarks, an error alert, keyboard-visible navigation labels, escaped event text,
and safe anchor schemes. Keep untrusted event payloads in plain text.

- [ ] **Step 2: Implement the visual direction**

Use an industrial editorial control-room aesthetic: graphite and warm paper, acid chartreuse for
confirmed live state, vermilion for failures, ruled grids, compact tabular numerals, and serif
headlines. Preserve the existing distinctive shell while increasing information density. Respect
`prefers-reduced-motion`, 320px layouts, contrast, and visible focus.

- [ ] **Step 3: Run the vertical-slice gate**

Run: `pnpm format && make verify-fast && make build`

Expected: all tests, generated-contract checks, typechecks, and production bundles pass.

- [ ] **Step 4: Record and commit the proof**

Add the exact test count and build result to `IMPLEMENTATION_STATUS.md`, then commit the complete
vertical slice with a focused `feat(web)` message.
