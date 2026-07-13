# Symphony Encore Technology Stack

Status: Draft v1

Purpose: Define the technology choices, package boundaries, runtime shape, and version policy for a
conforming Symphony Encore implementation. This document complements `SPEC.md`; where the service
specification defines behavior, this document defines the initial implementation baseline.

The key words MUST, MUST NOT, SHOULD, and MAY are used per RFC 2119. Choices in this document are
normative for the reference implementation unless a later architecture decision record replaces
them with evidence from a working implementation.

## 1. Implementation Principles

1. **One language by default.** Application code, browser code, shared contracts, build scripts that
   need program logic, and tests MUST use TypeScript. SQL migrations, shell entrypoints, Make targets,
   Dockerfiles, and generated files are narrow exceptions.
2. **The daemon is the product.** The long-running control plane owns orchestration. The browser UI
   is a client of its Control API, not the host of scheduler or workflow behavior.
3. **One local unit, explicit internal boundaries.** Production MAY run as one Node.js process, but
   domain, persistence, adapter, API, and UI boundaries MUST remain independently testable.
4. **Durability before convenience.** SQLite transactions and normalized durable records are the
   source of truth. In-memory actors, browser state, logs, and tracker comments MUST NOT become
   alternate decision stores.
5. **Boring dependencies win.** A dependency MUST solve a current requirement, have maintained
   documentation, support the chosen Node.js line, and be replaceable behind a small boundary.
6. **Local first, hosted later.** Version 1 runs one configured project per service instance on
   Linux or macOS, including Linux under WSL. Durable records MUST nevertheless carry `project_id`
   and repository identity so later multi-project hosting does not require a domain-model rewrite.

## 2. Runtime and Repository Baseline

The reference implementation MUST use:

- the latest Active LTS release line of Node.js that is mutually compatible with all required
  production dependencies;
- pnpm workspaces for package management;
- TypeScript in strict mode;
- a root Makefile as the stable human and CI command interface; and
- one lockfile committed at the repository root.

Node.js is the production runtime. Bun, Deno, and browser runtimes MUST NOT be required to operate
the service. A later runtime change requires conformance evidence for subprocess management,
signals, process-tree termination, SQLite behavior, and all Core tests from `SPEC.md`.

The repository SHOULD use this initial layout:

```text
apps/
  server/             process entrypoint, Fastify Control API, static UI hosting
  web/                Vite and React operator UI
packages/
  domain/             entities, policies, transition functions, domain errors
  contracts/          TypeBox schemas, OpenAPI definitions, generated client inputs
  persistence/        Kysely database, migrations, repositories, transaction helpers
  orchestration/      scheduler, claims, retries, review coordination, merge queue
  adapters/           tracker, repository host, Git, agent, and notification adapters
  observability/      Pino configuration, log bindings, metrics, event projection
  test-support/       fixtures, fake adapters, fake clocks, temporary databases
```

Package dependency direction MUST point inward: adapters, persistence, API, and UI may depend on
contracts or domain types; the domain package MUST NOT depend on Fastify, React, Kysely, Pino, a
provider SDK, or a concrete adapter.

Cycles between workspace packages are forbidden. CI MUST verify the package graph once packages
exist.

## 3. Browser Application

The operator UI MUST use:

- React;
- Vite;
- TanStack Router for typed routes and URL search state;
- TanStack Query for Control API server state;
- TanStack Table for data-heavy operator surfaces;
- shadcn/ui and Tailwind CSS for accessible, source-owned interface components; and
- a generated client derived from the shared OpenAPI contract.

The UI MUST treat the URL as the source of truth for shareable filters, selected tabs, pagination,
and history ranges. TanStack Query owns fetched server state. React component state owns only
ephemeral presentation state. The UI MUST NOT copy durable orchestration records into a second
client-side store.

XState MUST NOT be a global state-management dependency. It MAY be introduced for a bounded UI
workflow, such as first-run setup, only when a written statechart is clearer than an ordinary reducer
and the state remains subordinate to the Control API.

Next.js and TanStack Start are not part of the initial stack. Server-side rendering, React Server
Components, and framework server functions do not justify a second web-server lifecycle for the
authenticated operator console. Adding them requires a concrete hosted-product need and MUST NOT
move orchestration into request handlers.

The development Vite server MUST proxy Control API and event-stream requests to the Node.js server.
The production Vite build MUST produce static assets served by Fastify. A production deployment
therefore exposes one application port.

## 4. Control API and Live Updates

The server MUST use Fastify. Public request and response contracts MUST use TypeBox schemas that
produce both runtime validation and JSON Schema. The project MUST generate an OpenAPI document from
the same accepted schemas and MUST fail CI when the committed or generated client is stale.

The API MUST use ordinary HTTP resources and the error, authorization, expected-version, and
idempotency contracts from `SPEC.md`. tRPC and GraphQL are not part of the initial stack. Shared
TypeScript types MUST NOT replace a language-neutral wire contract.

Server-Sent Events (SSE) MUST provide browser delivery of live logs, stage transitions, usage,
budgets, and other append-only updates. SSE events MUST carry durable cursors so reconnecting clients
can resume or explicitly refresh after a gap. Mutations MUST remain ordinary authenticated HTTP
requests. WebSockets MAY be added only if a demonstrated bidirectional streaming requirement cannot
be served by HTTP plus SSE.

The API process and orchestration loop MAY run in one operating-system process in version 1. Their
module boundaries and shutdown paths MUST remain separate. An HTTP failure MUST NOT corrupt scheduler
state, and scheduler backpressure MUST NOT make health and operator-control endpoints unavailable.

## 5. Domain and Orchestration Model

Durable orchestration MUST use explicit TypeScript discriminated unions, pure transition functions,
and transactional command handlers. A transition follows this shape:

1. load the current durable aggregate and revision;
2. validate the typed event or terminal result;
3. compute decisions with a pure domain function;
4. atomically persist state, events, claim changes, and side-effect intents;
5. apply committed intents through typed adapters; and
6. persist receipts and reconcile the observed external revision.

XState actor snapshots MUST NOT be the durable source of truth. Temporal, BullMQ, Redis, and other
workflow or queue services are not part of the initial stack. The SQLite store is also the initial
durable scheduler queue.

Time, identifiers, randomness, process launch, filesystem access, network access, and provider calls
MUST enter orchestration through explicit interfaces. Tests MUST be able to replace each with a fake
without monkey-patching globals.

## 6. Persistence

The durable store MUST use:

- SQLite in write-ahead logging mode where supported by the deployment filesystem;
- `better-sqlite3` as the Node.js SQLite driver;
- Kysely as the typed SQL query builder; and
- ordered, immutable, repository-owned migrations.

Kysely is a query builder, not the owner of the domain model. Persistence code MUST map between
database rows and domain types at the package boundary. Kysely table interfaces, migrations, and row
mappers MUST change together.

Every schema change MUST include a migration and migration test. Applied migrations MUST NOT be
edited. Destructive changes MUST use an explicit expand, migrate, contract sequence unless a written
release policy proves that no durable installation can observe the intermediate version.

State transitions, claims, budget reservations, review aggregates, and side-effect intent creation
MUST use explicit transactions. Raw SQL MAY be used through Kysely's parameterized SQL facilities
when it expresses a SQLite invariant or query more clearly than the query builder. String-built SQL
with untrusted input is forbidden.

Tests for persistence MUST use real temporary SQLite databases with production migrations. Mocked
query-builder chains do not prove persistence behavior and MUST NOT be the only test of a repository.

The initial implementation MUST optimize honestly for SQLite and a single writer. It MUST NOT claim
drop-in PostgreSQL support merely because Kysely supports multiple dialects. A hosted PostgreSQL
implementation MAY replace the persistence package later while preserving domain and Control API
contracts.

## 7. Structured Logging

The service MUST use Pino for process-level structured logging. Fastify request logging MUST use its
Pino integration rather than a separate logger. Production output MUST be newline-delimited JSON;
local development MAY use `pino-pretty` outside the durable event path.

Each component MUST create child loggers with stable bindings. Applicable records include
`service_run_id`, `project_id`, `work_ref`, `attempt_id`, `session_id`, repository identity, and stage.
Event names and reason codes MUST be fields, not text parsed from the human message.

One root configuration MUST define levels, serializers, and redaction. Authorization headers,
cookies, credentials, secret references, full prompts, raw diffs, and provider tokens MUST be removed
before leaving the process. Bounded non-sensitive metadata, such as an allowed path, changed-file
count, command class, or verification result, MAY remain when required by `SPEC.md`. User-controlled
values MUST NOT define redaction paths.

Pino output is operational telemetry, not the durable orchestration record. Events and logs required
by `SPEC.md` MUST first be written to SQLite and MAY then be projected to Pino. The service MUST NOT
make a guard, retry, budget, or merge decision by reading process logs.

## 8. Testing and Static Analysis

The reference implementation MUST use:

- Vitest for unit, contract, component, and Node.js integration tests;
- Playwright for browser and end-to-end tests;
- Biome for formatting and linting;
- the TypeScript compiler with `noEmit` for type checking; and
- real temporary repositories, processes, and SQLite databases for boundary integration tests.

Unit tests MUST cover pure policy and transition functions. Contract tests MUST run every adapter
against the shared conformance fixtures. Integration tests MUST exercise migrations, transactions,
restart recovery, process-tree termination, and intent/receipt reconciliation. Browser tests MUST
cover the required UI surfaces and security-sensitive mutation behavior from `SPEC.md`.

Coverage is a diagnostic, not proof of conformance. CI SHOULD establish an initial measured coverage
floor and MUST prevent unexplained regression below that floor. It MUST NOT reward low-value tests
written only to meet a percentage.

`make verify` MUST be the canonical full local and CI gate. Narrow commands MAY exist for iteration,
but CI MUST compose the same repository-owned commands used locally.

## 9. Local Development and WSL

The initial supported development hosts are Linux, macOS, and Linux under WSL. Native Windows is not
an initial requirement.

The repository MUST provide at least:

```text
make setup       install the pinned toolchain dependencies and repository hooks
make dev         run the web and server development processes under one supervisor
make build       build all production artifacts
make test        run the normal test suite
make verify      run the complete local/CI verification gate
make start       run the built production service
```

`make dev` MUST keep both development processes in one terminal, forward termination signals, and
return a failing status if either required process exits unexpectedly. Individual package commands
MAY remain available for debugging.

The server binds to the `SPEC.md` loopback default and MUST print the exact UI URL after startup. It
MUST NOT require or attempt to launch a graphical browser. A service running inside WSL MUST be
usable from the Windows host through the WSL localhost forwarding path. Documentation MUST explain
an explicit non-loopback bind as a security-sensitive exception, not a troubleshooting default.

## 10. Container and Distribution Model

The initial release MUST support a normal Node.js installation. It SHOULD also provide a
multi-stage Docker image that contains the built server, static UI, production dependencies, and
required operating-system utilities.

The production image MUST:

- run as a non-root user;
- use a read-only root filesystem where the deployment permits it;
- write only to declared database, workspace, and temporary volumes;
- expose a health check that distinguishes startup/recovery from readiness;
- contain no build credentials or source-control tokens;
- accept secrets only at runtime; and
- preserve signal delivery to the Node.js process.

Container documentation MUST make workspace mounts, Git identity, repository-host credentials,
agent credentials, and the agent executable boundary explicit. Mounting a host Docker socket grants
host-equivalent authority and MUST NOT be the default or be described as ordinary isolation.

The Docker image is a deployment option, not a reason to require Docker for contributors. Release
artifacts MAY later include a self-contained executable only after subprocess, native dependency,
and SQLite behavior pass the Core conformance profile on every supported host.

## 11. Version and Dependency Policy

The first implementation of each dependency MUST select the newest stable, non-prerelease version
that is mutually compatible with the chosen Node.js Active LTS line, peer dependencies, build tools,
native modules, and supported host platforms. “Latest” MUST mean latest compatible at the time of the
change; it MUST NOT mean an unpinned floating version resolved on every CI run.

The repository MUST record exact resolved versions in `pnpm-lock.yaml`. It MUST pin the package
manager in `package.json`, constrain Node.js in `engines`, and provide one repository-owned toolchain
version file used by developers, CI, and Docker builds. Container base images and GitHub Actions MUST
be immutable in execution, with automated pull requests used to keep those pins current.

Prerelease dependencies require an architecture decision record that states the missing stable
capability, operational risk, rollback path, and removal condition. Packages with incompatible or
unmaintained transitive dependencies MUST NOT be adopted merely to preserve a preferred top-level
choice.

Automated dependency updates MUST follow `CICD.md`. A dependency update receives the same validation
as application code. Major upgrades MUST be isolated from unrelated changes and MUST include a review
of release notes, migrations, peer-dependency changes, and runtime support.

## 12. Deferred Choices and Revisit Triggers

The following are deliberately deferred:

- multi-project configuration in one running instance;
- multi-tenant authorization and tenant isolation;
- PostgreSQL and horizontally scaled schedulers;
- remote worker fleets;
- WebSockets;
- server-side rendering;
- a Go, Rust, or Elixir service component;
- XState as a backend workflow engine;
- Temporal, Redis, or a general-purpose job queue; and
- a self-contained desktop application or executable distribution.

A deferred choice MAY be reconsidered when a measured requirement appears. Preference, novelty, or
theoretical future scale is not evidence. Any replacement MUST preserve the normative contracts in
`SPEC.md`, supply a migration path for durable state, and pass the applicable conformance profile.

## 13. Non-Normative References

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [Vite backend integration](https://vite.dev/guide/backend-integration.html)
- [TanStack Router external data loading](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Fastify logging](https://fastify.dev/docs/latest/Reference/Logging/)
- [Kysely migrations](https://kysely.dev/docs/migrations)
- [Kysely transactions](https://kysely.dev/docs/category/transactions)
- [Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)
- [Vitest guide](https://vitest.dev/guide/)
- [Playwright documentation](https://playwright.dev/docs/intro)
- [Biome documentation](https://biomejs.dev/guides/getting-started/)
