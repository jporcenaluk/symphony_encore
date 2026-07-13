# Symphony Encore Core Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-driven development. Check off
> steps only after the named command passes, and update `IMPLEMENTATION_STATUS.md` with the evidence.

**Goal:** Build the complete Symphony Encore Core-conformance service, delivery system, and required
operator UI described by `SPEC.md`, `TECH_STACK.md`, and `CICD.md`, then open one verified pull
request containing the implementation.

**Architecture:** A single Node.js daemon hosts a Fastify Control API and the built React UI while
the domain, persistence, orchestration, adapter, observability, and contract packages remain acyclic
and independently testable. SQLite is the single durable decision store. Pure domain functions
compute decisions; transactional command handlers commit state and side-effect intents; typed
adapters apply authorized external effects and persist receipts.

**Tech Stack:** Node.js 24 Active LTS, pnpm 11, TypeScript 7 strict mode, Fastify, TypeBox, Kysely,
better-sqlite3, Pino, React, Vite, TanStack Router/Query/Table, Tailwind CSS, Vitest, Playwright, and
Biome. Exact compatible versions are resolved once into the root lockfile.

---

## Execution rules

1. Use one long-lived feature branch and one final pull request.
2. Use red-green-refactor for every behavior change. Record the failing and passing command.
3. Keep package dependencies inward and run the graph check with every new package edge.
4. Add each durable schema change as a new immutable migration plus a migration test.
5. Update `IMPLEMENTATION_STATUS.md` after each verified vertical slice.
6. Do not claim Core Conformance until every Section 19.2 ID has direct automated evidence.
7. Do not claim production readiness until the Real Integration Profile has a redacted report.

## File map

```text
apps/server/                 process lifecycle, Fastify API, auth, SSE, static UI hosting
apps/web/                    operator UI and generated Control API client
packages/domain/             durable entities, policies, transitions, and domain errors
packages/contracts/          TypeBox wire schemas, OpenAPI generation, adapter contracts
packages/persistence/        Kysely database, migrations, repositories, transactions
packages/orchestration/      scheduler, commands, recovery, budgets, review, merge, learning
packages/adapters/           GitHub, Codex app-server, Git, process, workspace, notification
packages/observability/      durable event/log projection, Pino, redaction, metrics
packages/test-support/       fake clocks/adapters, fixtures, temporary databases/repositories
tests/integration/           multi-package SQLite, process, workspace, and recovery tests
tests/e2e/                   Playwright tests against the production build
scripts/                     policy, generation, conformance, and CI helper programs
.github/workflows/           pinned CI, CodeQL, publication, and release workflows
docs/operations/             setup, WSL, security posture, container, rollback, smoke tests
```

## Milestone 1: Executable repository baseline

**Files:** root toolchain files, workspace manifests, package manifests, `Makefile`, policy scripts,
and one smoke test per workspace package.

- [x] Pin Node 24 Active LTS and pnpm 11 in `.node-version`, `package.json`, and the lockfile.
- [x] Configure strict shared TypeScript, Biome, Vitest, coverage, Markdownlint, and package graph
  validation without allowing CI to rewrite files.
- [x] Create every required workspace package and both apps with inward-only dependencies.
- [x] Implement every stable Make target from `CICD.md` Section 12; targets that depend on later
  milestones must fail with a clear `not implemented` result until replaced by real checks.
- [ ] Add a policy test that rejects package cycles, forbidden dependencies, floating action refs,
  conflict markers, and generated-contract drift.
- [x] Verify with `make verify-fast`; expect all implemented baseline checks and smoke tests to pass.

## Milestone 2: Contracts and pure domain model

**Files:** `packages/contracts/src/**/*.ts`, `packages/domain/src/**/*.ts`, and paired Vitest files.

- [ ] Define branded identifiers, `WorkRef`, every Section 3 entity, enum, evidence reference, agent
  event, terminal role result, and adapter request/response as TypeBox schemas and inferred types.
- [ ] Add schema refinements for exclusive work references, role-specific result fields, terminal
  attempt invariants, authorization scopes, and ReviewSet carry-forward invariants.
- [ ] Implement pure lane, claim, attempt, classification, routing, outcome, review, merge, budget,
  retention, and failure transition functions with exhaustive discriminated-union handling.
- [ ] Generate and commit JSON Schemas for agent tools and public contracts; fail drift checks when
  generated output changes.
- [ ] Verify with `pnpm --filter @symphony/domain test` and
  `pnpm --filter @symphony/contracts test`.

## Milestone 3: Workflow configuration and immutable snapshots

**Files:** `packages/orchestration/src/config/**`, configuration tables in contracts, fixture
`WORKFLOW.md` files, and `tests/integration/config/**`.

- [ ] Implement trusted path precedence, YAML front matter, strict prompt compilation, source
  metadata, defaults, path expansion, secret references, and operator-visible unknown-key warnings.
- [ ] Implement safety-critical Levenshtein near-miss rejection, all cross-field validation, adapter
  capability/skill preflight, file watching, and last-known-good reload behavior.
- [ ] Implement durable override candidates, exact-hash acknowledgments, hot/attempt/restart state,
  bootstrap-key rejection, and immutable snapshot creation.
- [ ] Prove `C-WF-01` through `C-WF-05` and `C-WF-07` with deterministic tests.

## Milestone 4: SQLite control-plane persistence

**Files:** `packages/persistence/src/migrations/**`, row types/mappers, transaction helpers, every
repository, and temporary-database fixtures.

- [ ] Open SQLite in WAL mode where supported, acquire one writer, and apply ordered migrations in
  a transaction.
- [ ] Create normalized tables, constraints, and indexes for every durable entity in Section 3,
  configuration history, evidence, events, notifications, retention tombstones, and quality data.
- [ ] Implement repository boundaries that map rows to domain values without leaking Kysely types.
- [ ] Implement atomic command primitives for claim/attempt/reservation creation, attempt closure,
  stage transitions, operator mutations, ReviewSets, and side-effect intent/receipt state.
- [ ] Prove migrations from every supported schema, rollback, uniqueness, restart persistence, and
  query completeness with real temporary database files.

## Milestone 5: Authentication, bootstrap, and operator mutation kernel

**Files:** `apps/server/src/auth/**`, `apps/server/src/bootstrap/**`,
`packages/orchestration/src/operator/**`, and security integration tests.

- [ ] Implement salted local credentials, revocable server-side sessions, capability lookup from
  effective operators, secure cookie policy, same-origin checks, and CSRF tokens.
- [ ] Implement pristine-store detection and loopback-only single-use bootstrap with exact candidate
  hash confirmation and one atomic administrator transaction.
- [ ] Implement non-pristine operator-loss recovery: process termination, query-only intent
  reconciliation, durable failure, and closed startup.
- [ ] Implement scoped idempotency, expected-version checks, durable audit for every authenticated
  acceptance or rejection, and typed structured errors.
- [ ] Prove `C-WF-06` and the authentication/operator portions of `C-UI-05`.

## Milestone 6: Budgets, usage, and durable time

**Files:** `packages/orchestration/src/budget/**`, usage and stage repositories, and concurrency
integration tests.

- [ ] Implement attempt, issue, and rolling ledgers for priced USD and unpriced token scopes.
- [ ] Implement history-based nearest-rank p75 estimates, atomic fan-out reservation, top-up,
  settlement, release, overrun, allowance epochs, and audited adjustment.
- [ ] Deduplicate absolute session totals and derive all attempt/SystemJob/issue/class/role/profile
  and rolling aggregates from UsageSamples.
- [ ] Implement hard-cap termination decisions and reconstruct stage and total elapsed time.
- [ ] Prove `C-BUD-01` through `C-BUD-04` with deterministic clocks and concurrent connections.

## Milestone 7: Workspace, process, and Codex agent adapter

**Files:** `packages/adapters/src/workspace/**`, `process/**`, `codex/**`, fixture subprocesses, and
Linux/macOS process integration tests.

- [ ] Implement sanitized paths, realpath containment, symlink/bind escape checks, isolated HOME,
  temporary/cache paths, scrubbed allowlisted environments, ownership, quarantine, and cleanup.
- [ ] Implement repository population at a recorded base SHA and non-login bounded hooks.
- [ ] Launch process groups, stream bounded protocol messages, forward signals, enforce read/turn/
  stall/token/USD limits, and verify full descendant termination on every end state.
- [ ] Generate the installed Codex protocol schema, negotiate capabilities before charging, map all
  Appendix B events/errors, and expose role-specific `report_result` plus implementation
  `submit_plan` tools.
- [ ] Prove `C-SEC-01`, `C-SEC-02`, `C-DUR-03`, and `C-PLAN-04`.

## Milestone 8: Authorized external adapters

**Files:** `packages/adapters/src/github/**`, `git/**`, `notification/**`, shared conformance fixtures,
and fake-provider integration tests.

- [ ] Implement every tracker and repository-hosting operation in Section 16 with complete cursor
  pagination, normalization, revision checks, provider request IDs, and typed errors.
- [ ] Implement GitHub Issues + Projects v2 lane/priority/blocker/criteria normalization and the
  GitHub pull-request snapshot contract.
- [ ] Implement branch/PR/update/merge/repair operations and notification command/webhook delivery.
- [ ] Require the same persisted, unexpired, exact-match MutationAuthorization on every mutating
  adapter call and reconcile unknown intents by idempotency key.
- [ ] Prove `C-DUR-04` and `C-SEC-03` against the shared adapter conformance suite.

## Milestone 9: Scheduler, dispatch, reconciliation, and outcome routing

**Files:** `packages/orchestration/src/scheduler/**`, `commands/**`, `recovery/**`, `outcomes/**`, and
multi-package integration scenarios.

- [ ] Implement the ordered poll tick, eligibility sorting, required-label/assignee/blocker checks,
  global slots, immediate trigger, and validation-failure reconciliation behavior.
- [ ] Implement atomic issue and SystemJob dispatch, receipt-confirmed lanes, workspaces, hooks,
  leases, running/ready/retry/human claim modes, and independent verification records.
- [ ] Implement every Section 5.4 route, cap, retry class, backoff/jitter, tracker drift behavior,
  persistence-failure stop, and startup recovery algorithm.
- [ ] Prove `C-DUR-01`, `C-DUR-02`, `C-DUR-05`, and the lifecycle portion of `C-PLAN-01`.

## Milestone 10: Plans, classification, review, merge, quality, and learning

**Files:** the remaining `packages/orchestration/src/{plans,review,merge,quality,learning}/**` modules
and scenario tests.

- [ ] Implement typed Plan submission, acceptance-criterion coverage, standard and high-risk gates,
  revision caps, factual handoffs, and upward-only authoritative classification.
- [ ] Implement deterministic checks, integrative/specialist fan-out, finding union, narrow
  adjudication, complete ReviewSets, immutable revision checks, and supervised approval.
- [ ] Implement per-repository merge serialization, current snapshot gating, normalized patch
  identity, exact carry-forward, landing, post-merge observation, and repair SystemJobs.
- [ ] Implement sampled audits, escaped defects, autonomy evidence/demotion, lesson capture,
  budgeted synthesis, and saturation/decay.
- [ ] Prove `C-PLAN-01` through `C-PLAN-03` and `C-REV-01` through `C-REV-05`.

## Milestone 11: Control API, OpenAPI, generated client, and live updates

**Files:** `apps/server/src/api/**`, `packages/contracts/src/openapi/**`, generated client output,
and API integration tests.

- [ ] Implement every Section 14.4 read and mutation with TypeBox request/response schemas,
  authentication/capabilities, idempotency, expected versions, audit, pagination, and safe URLs.
- [ ] Generate OpenAPI from accepted route schemas and generate the browser client from that file;
  fail CI on either drift.
- [ ] Implement durable cursor-based SSE for logs, stages, usage, budgets, and events, including
  resume and explicit gap refresh.
- [ ] Keep health/readiness available during scheduler recovery/backpressure and emit a restrictive
  Content Security Policy.

## Milestone 12: Required operator UI

**Files:** `apps/web/src/**`, shadcn source components, styles, and Playwright component/E2E tests.

- [ ] Build bootstrap/login, dashboard, issue/run history, and settings/control routes using the
  generated client, TanStack Router URL state, Query server state, and Table data surfaces.
- [ ] Display every required status, budget, timing, history, evidence, link, configuration source,
  pending state, queue, approval, notification, and audit record.
- [ ] Keep failed submitted values with structured errors, never show optimistic configuration as
  effective, and visibly mark stale data or API errors.
- [ ] Escape hostile content, sanitize supported rich text, reject unsafe schemes, and reconnect
  live streams from durable cursors.
- [ ] Prove `C-UI-01` through `C-UI-07` against the built application.

## Milestone 13: Operations, retention, setup, and distribution

**Files:** guided setup command, retention services, Docker files, operational documentation, and
runtime tests.

- [ ] Implement the idempotent guided first-run setup sequence without opening the database or a
  network listener and require confirmation for each tracker schema mutation.
- [ ] Implement indefinite default history and protected finite retention with audited tombstones.
- [ ] Build and start normal Node distribution artifacts and one-port static UI/API service.
- [ ] Build a digest-pinned multi-stage image that runs as non-root, preserves Node signal handling,
  declares writable volumes, and distinguishes startup from readiness.
- [ ] Document Linux, macOS, WSL, non-loopback security, credentials, agent boundary, mounts,
  container posture, release smoke test, and rollback.

## Milestone 14: Canonical CI/CD and conformance

**Files:** `.github/**`, policy scripts, reports, and final Make targets.

- [ ] Implement pinned PR/merge-group/main CI with stable jobs for policy, supply chain, static
  checks, unit/contract coverage, Linux/macOS integration, production build, Playwright, and image.
- [ ] Add pinned CodeQL, Dependabot, Gitleaks, actionlint, zizmor, Markdownlint, dependency review,
  Trivy, SBOM, checksum, and provenance controls with least-privilege permissions.
- [ ] Publish verified `main` images by immutable SHA/digest and promote existing artifacts for
  immutable semantic version tags without rebuilding; do not invent a deployment environment.
- [ ] Replace every provisional Make failure with the real check and run `make verify` from a clean
  frozen install.
- [ ] Run the entire Section 19.2 matrix and generate the Core conformance report.
- [ ] Run the Real Integration Profile in a non-production GitHub repository and record redacted
  evidence for every Section 19.3 scenario.
- [ ] Inspect and configure repository rules, publish the branch, open the Conventional
  Commit-titled pull request, and verify every required check on its exact head SHA.

## Completion audit

- [ ] Every row in `IMPLEMENTATION_STATUS.md` has direct evidence and no `Not started` or
  `In progress` state.
- [ ] Every normative command and artifact named in the three source documents exists and works.
- [ ] `make setup && make verify` passes from a clean checkout with the pinned toolchain.
- [ ] The built Node service and container pass health, readiness, one-port UI/API, signal, and
  persistent-volume checks.
- [ ] Core and Real Integration conformance reports identify exact revisions and contain no partial
  requirement claims.
- [ ] The pull request contains the complete intended file list, is current with `main`, and all
  required checks pass for the exact PR head.
