# Symphony Encore Architecture

Status: Draft v1

Purpose: Define the internal architecture of the Symphony Encore reference implementation — the
final package structure, the placement and purpose of every module, the design patterns the
implementation is built from, and the theory that makes those choices coherent. `SPEC.md` defines
*what* the service does, `TECH_STACK.md` defines *which* technologies implement it, and `CICD.md`
defines *how* changes are delivered. This document defines *how the implementation is shaped* so
that all three can be satisfied without structural rework.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as
shown here.

Precedence: `SPEC.md`, `TECH_STACK.md`, and `CICD.md` are normative over this document. A conflict
between this document and any of them is a defect in this document and MUST be resolved in their
favor. This document is normative over module placement, dependency direction, and pattern usage in
the reference implementation; deviations require an architecture decision record (Section 12).

## 1. Architectural Theory

The architecture rests on five load-bearing ideas. Every structural rule in this document derives
from one of them.

1. **A single serialized coordination core.** All orchestration decisions flow through one
   run-to-completion event loop that owns the authoritative runtime state. Concurrency lives at the
   edges (agent subprocesses, verification runs, HTTP requests, adapter I/O); decisions never do.
   This is the actor discipline of the Symphony Elixir reference implementation translated to
   Node.js, where the event loop provides the same serialization a GenServer mailbox provides on
   the BEAM. It is what makes SPEC invariants — poll-tick ordering, atomic claim transitions,
   upward-only reclassification, no unowned gaps between stages — enforceable in one place instead
   of re-proven in every module.

2. **Functional core, imperative shell.** Every decision is a pure function from
   `(durable state, typed event, effective configuration)` to
   `(state changes, side-effect intents)`. Effects — SQLite writes, adapter calls, process
   launches, timers — happen only in thin imperative shells that surround the pure core. Pure
   decisions are unit-testable exhaustively; shells are integration-tested against real
   boundaries.

3. **The durable store is the truth; memory is a projection.** SQLite records (claims, attempts,
   plans, review sets, ledgers, intents, receipts) are the only decision inputs, per SPEC
   principle 3. All in-memory state — the scheduler's running map, timers, caches — MUST be
   reconstructible from durable records plus external observation, and restart recovery MUST prove
   it. Nothing reads logs, tracker comments, or browser state to make a decision.

4. **Policy is data.** Outcome routing (SPEC §5.4), risk-floor rules (SPEC §8), change-class
   gates (SPEC §4), reviewer requirements (SPEC §9), failure classification (SPEC §13), and
   configuration reload categories (SPEC §18.1) are all specified as tables. The implementation
   MUST represent them as typed data structures interpreted by small generic engines, not as
   branching code duplicated per case. Adding a route, rule, or key changes a table row, not a
   module.

5. **One behavior, one home.** Each SPEC responsibility lives in exactly one module with one
   reason to change. The unit of growth is a new event type plus a pure function — not a new
   module family. Lifecycle phases (initial, continuation, retry) and attempt roles are *values*
   flowing through one state machine, never encodings in file names.

## 2. Final Repository Structure

The workspace MUST use this layout. It refines the initial layout in `TECH_STACK.md` §2 with the
internal structure of each package.

```text
apps/
  server/                    composition root only (Section 3.1)
    src/
      main.ts                process entry: trusted bootstrap args, wiring, lifecycle
      composition/           construct adapters, stores, services; inject into orchestration
      http/                  Fastify instance, route registration, SSE, static UI hosting
  web/                       React operator console (Section 8)
    src/
      routes/                TanStack Router route tree (URL is state)
      views/                 operations, history, settings surfaces
      components/            shadcn/ui source-owned components
      api/                   generated client wiring, TanStack Query hooks, SSE subscription

packages/
  contracts/                 wire and record truth (Section 3.2)
    src/
      records/               TypeBox schemas for every SPEC §3 durable entity
      results/               role terminal-result schemas (SPEC §3.3, §3.17)
      events/                normalized agent events and error codes (SPEC Appendix B)
      control-api/           Control API request/response schemas
      conformance/           Core test-matrix case registry (SPEC §19.2)
    generated/               OpenAPI document, JSON schema, generated client (drift-checked)

  domain/                    pure policy (Section 3.3)
    src/
      classification.ts      change classes, provisional/authoritative, monotonicity
      routing.ts             compute profiles, risk floors, escalation policy
      outcome-table.ts       SPEC §5.4 routing table as data + its interpreter
      budget-policy.ts       reservation math, estimates, cap decisions
      review-policy.ts       reviewer sets, finding union, adjudication triggers
      merge-gate.ts          check/review/thread gate, patch identity, carry-forward rules
      failure-policy.ts      SPEC §13 failure classes and retry decisions
      learning-policy.ts     lesson sources, saturation caps, rule decay
      lifecycle.ts           lane/stage transition legality

  orchestration/             the coordination core (Section 4)
    src/
      kernel/                event queue, reducer loop, timer service, runtime services
      lifecycle/             the one Attempt state machine + per-role strategies
      scheduler/             poll tick, reconciliation, eligibility, dispatch
      review/                review coordination over the lifecycle machine
      merge/                 per-repository merge queues
      budget/                ledger orchestration: reserve, top-up, release, park
      learning/              lesson capture and synthesis SystemJob triggering
      config/                workflow loading, resolution, reload boundaries, acknowledgment
      recovery/              startup recovery, process ownership, intent reconciliation

  persistence/               durable truth (Section 5)
    src/
      schema/                fully typed Kysely table interfaces (one file per aggregate)
      migrations/            ordered, immutable, one file per migration
      repositories/          typed row mappers + queries, one per aggregate
      commands/              transactional command handlers mirroring SPEC §19.4 algorithms
      outbox.ts              SideEffectIntent/Receipt store and reconciliation queries
      writer-lock.ts         exclusive service-writer lock and fencing epoch

  adapters/                  the outside world (Section 6)
    src/
      tracker/               contract + github/ + memory/
      repo-hosting/          contract + github/ + memory/
      agent/                 contract + codex/ + scripted/ (deterministic fake)
      notification/          contract + command/ + webhook/ + memory/
      sandbox/               workspace write-boundary enforcement per platform
      process/               process-group launch, termination, ownership verification
      auth/                  operator authentication adapters (local, oidc, proxy)
      authorization.ts       shared MutationAuthorization envelope validation

  observability/             seeing the system (Section 7)
    src/
      logging.ts             Pino root config, redaction, child-logger bindings
      log-store.ts           durable scrubbed LogRecord projection (SQLite first, Pino second)
      event-store.ts         append-only EventRecord projection
      presenters/            pure snapshot -> payload projections for API, UI, and status

  test-support/              first-class fakes and harnesses (Section 10)
    src/
      runtime-services.ts    fake clock, ids, randomness
      scenario/              whole-daemon scenario harness on memory adapters
      fixtures/              shared adapter contract fixtures

scripts/                     repository policy, generation, and evidence tooling
.github/workflows/           ci.yml, codeql.yml, publish-container.yml, release.yml (Section 9)
Makefile                     the stable command interface (CICD §12)
```

### 2.1 The Dependency Rule

Dependencies MUST point inward and CI MUST enforce the graph (TECH_STACK §2):

```text
apps/web ──► contracts
apps/server ──► orchestration, persistence, adapters, observability, contracts, domain
orchestration ──► domain, contracts        (and persistence/adapters ONLY via injected interfaces)
persistence ──► domain, contracts
adapters ──► contracts
observability ──► contracts
domain ──► contracts
contracts ──► (nothing)
```

- `domain` MUST NOT import Fastify, React, Kysely, Pino, any provider SDK, or Node built-ins that
  perform I/O.
- `orchestration` MUST NOT import concrete adapters or Kysely; it consumes interfaces defined in
  its own `kernel/` and implemented by `persistence` and `adapters`, injected by the composition
  root. This is the dependency-inversion boundary that keeps the coordination core testable
  against fakes.
- Workspace package cycles are forbidden and MUST fail CI.

## 3. Module Placement and Purpose

### 3.1 `apps/server` — composition root, nothing else

`apps/server` MUST contain only: the process entrypoint (trusted bootstrap argument handling per
SPEC §18.1), construction and wiring of concrete adapters/stores/services, the Fastify HTTP
surface (routes delegate to presenters and command handlers; they contain no policy), SSE
delivery, and static UI hosting. It is the only place where every package is visible at once.

`apps/server` MUST NOT contain scheduling, lifecycle, review, merge, budget, or recovery logic. A
repository policy check MUST fail when orchestration behavior appears under `apps/server/src`.

### 3.2 `packages/contracts` — the shared truth about shapes

One TypeBox schema per SPEC §3 entity, per role terminal result, per normalized agent event, and
per Control API resource. Runtime validation, JSON Schema, the OpenAPI document, and the generated
browser client MUST all derive from these schemas; CI MUST fail on drift (CICD §5.3). The Core
conformance case registry (SPEC §19.2) lives here as typed data so evidence tooling and tests share
one source of case identity.

### 3.3 `packages/domain` — pure decisions

Every function in `domain` MUST be deterministic and effect-free. This is where the policy tables
of Section 1 idea 4 live, together with their interpreters. Each SPEC policy section maps to one
module (see the layout above). `domain` is the highest-coverage, cheapest-to-test code in the
repository and SHOULD be the target of mutation testing first.

### 3.4 Where each SPEC §2 component lands

| SPEC component | Home | Notes |
|---|---|---|
| 1. Workflow Loader | `orchestration/config` | parsing pure; snapshot commit via `persistence/commands` |
| 2. Orchestrator | `orchestration/kernel` + `scheduler` | the serialized core (Section 4) |
| 3. Durable State Store | `persistence` | sole writer; lock in `writer-lock.ts` |
| 4. Workspace Manager | `orchestration/lifecycle` + `adapters/sandbox` | policy vs. OS enforcement split |
| 5. Agent Runner | `orchestration/lifecycle` + `adapters/agent`, `adapters/process` | protocol in adapter; limits in lifecycle |
| 6. Review Coordinator | `orchestration/review` + `domain/review-policy` | |
| 7. Merge Queue | `orchestration/merge` + `domain/merge-gate` | |
| 8. Tracker / Repo-Hosting Adapters | `adapters/tracker`, `adapters/repo-hosting` | |
| 9. Learning Synthesizer | `orchestration/learning` + `domain/learning-policy` | |
| 10. Notifier | `adapters/notification` | same intent/receipt path as all mutations |
| 11. Control API + UI | `apps/server/http` + `apps/web` | payloads from `observability/presenters` |
| 12. Observability | `observability` | durable-first, Pino-second (Section 7) |

## 4. The Coordination Core

### 4.1 The kernel: one loop, typed events, run-to-completion

`orchestration/kernel` implements a single event loop:

- **One typed event union** covers everything that can change orchestration state: poll tick due,
  candidate batch fetched, worker event (agent adapter), worker exit, verification finished, timer
  due (retry, lease renewal, reminder, settle), adapter receipt, control command (operator
  mutation), configuration change.
- **Run-to-completion:** the loop processes exactly one event at a time. Each turn is:
  load durable state → call a pure `domain`/`orchestration` decision function → commit one SQLite
  transaction (state + events + claim change + side-effect intents) → hand committed intents to
  adapters → enqueue any follow-up events. A turn MUST NOT await adapter I/O between decision and
  commit.
- **Event-loop discipline:** because `better-sqlite3` is synchronous and Node.js is cooperatively
  scheduled, each reducer turn MUST stay short (one event, one transaction). All slow work — agent
  sessions, verification commands, git operations, provider calls — MUST run in child processes or
  detached async tasks that report back *as events*. Health and operator-control endpoints MUST
  remain responsive under full scheduler load, and a test MUST prove it.
- **Timer tokens:** every scheduled timer carries a token recorded in runtime state; a firing
  whose token is stale MUST be ignored. Durable `due_at` fields make timers restart-safe; tokens
  make them reload-safe. Both are REQUIRED.
- **Runtime services:** time, identifiers, randomness, process launch, filesystem, and network
  enter the kernel only through an injected interface (TECH_STACK §5) so every scenario test can
  run on a fake clock.

### 4.2 The lifecycle: one Attempt machine, roles as strategies

There is exactly ONE attempt state machine (`orchestration/lifecycle`). SPEC §3.2 models Attempt
as one entity with a role enum, one claim, one budget reservation, and one terminal record — the
implementation MUST mirror that:

- The machine owns the invariants shared by all roles: transactional claim acquisition, budget
  reservation, workspace preparation, event consumption, at-most-one schema-valid terminal result,
  atomic close-and-route, process-tree termination.
- Each role (`plan_review`, `implementation`, `integrative_review`, `specialist_review`,
  `adjudication`, `synthesis`) is a **strategy object** supplying only what differs: prompt
  inputs, terminal-result schema, and its row in the outcome routing table.
- Phases (initial, continuation, rework, repair) are values in the Attempt record and inputs to
  prompt construction — file names and module boundaries MUST NOT encode them.
- Outcome routing MUST be driven by the `domain/outcome-table.ts` data structure that transcribes
  SPEC §5.4. Issue lanes and SystemJob stages are two projections of the same routing decision.

### 4.3 One exit path for workers

Every worker termination — normal result, crash, timeout, stall, token/USD cap, cancellation —
MUST resolve to a single typed `worker_exit` event handled by one routing function. Retry policy,
`ExecutionFailure` authoring, and lesson capture happen there and nowhere else. A worker MUST NOT
decide its own retry.

### 4.4 Configuration read at the boundary

The scheduler and lifecycle MUST NOT cache configuration at construction. Hot-category values are
read from the effective-configuration resolver at each tick and each dispatch; attempt-category
values are pinned into the immutable snapshot at dispatch; restart-category values are read once at
startup. With this rule, SPEC §18.1 reload semantics are an emergent property of *where a value is
read*, not a propagation mechanism to build and test separately.

## 5. Persistence Architecture

- **Typed schema.** Every Kysely table interface MUST be fully typed — `Record<string, unknown>`
  is prohibited. Table interfaces, migrations, and row mappers change together (TECH_STACK §6).
- **Ordered migrations.** One immutable file per migration under `persistence/migrations/`, each
  with a migration test. Destructive changes follow expand–migrate–contract.
- **Repositories map rows to domain types.** One repository per aggregate. Repositories contain
  queries and mappers only — no policy.
- **Command handlers are the mutation kernel.** The transactional algorithms of SPEC §19.4
  (`start_service`, `dispatch`, `finish_attempt`, `activate_override`, `control_mutation`) MUST
  each exist as exactly one command handler in `persistence/commands/`, composing repositories
  inside one transaction. All writers go through command handlers; ad-hoc multi-store transactions
  scattered across features are prohibited. This is the Unit-of-Work pattern with the SPEC's own
  algorithm names.
- **Transactional outbox.** `SideEffectIntent` before the adapter call, `SideEffectReceipt` after,
  committed in the same transactions as the decisions that caused them; startup and normal-start
  recovery reconcile unreceipted intents by idempotency key before any dispatch. Every external
  mutation — tracker, repository host, notification — flows through the outbox without exception.
- **Exclusive writer.** A pre-database, lifetime-exclusive writer lock with a fencing epoch MUST
  be acquired before the store opens. A second service instance MUST fail closed.

## 6. Adapter Architecture

Each adapter family declares one narrow contract in `adapters/*/contract.ts` (mirroring SPEC §16
and §17 operations), one or more real implementations, and one **in-memory implementation that is
a first-class adapter** — selected through ordinary configuration, not test injection. The memory
adapters MUST be complete enough to run the entire daemon end-to-end deterministically; they are
the substrate of the conformance scenario harness (Section 10) and MUST pass the same shared
contract fixture suite as the real implementations.

All mutating adapter operations accept the persisted `MutationAuthorization` envelope and MUST
reject missing, expired, mismatched, or stale envelopes (SPEC §3.14). Envelope validation is
implemented once in `adapters/authorization.ts` and reused by every family. Agent and reviewer
processes MUST NOT be able to reach adapter credentials (SPEC §15.1); the sandbox and process
adapters enforce that boundary at the OS level per platform.

## 7. Observability Architecture

- **Durable first, Pino second.** SPEC-required logs and events are written to SQLite (scrubbed,
  bounded) and MAY then be projected to Pino. Process logs are operational telemetry; no decision
  and no UI surface reads them.
- **Snapshot → presenter → every surface.** There is one canonical, serializable runtime snapshot
  (scheduler state joined with durable read models). Pure presenter functions in
  `observability/presenters/` project it into Control API payloads and UI view models. The
  terminal status line, the JSON API, and the React console MUST all render from presenter
  output — never from private scheduler state. Presenters MUST be covered by golden snapshot
  tests (fixture state in, committed payload out), which is the cheap deterministic coverage for
  the broad UI surfaces SPEC §14.3 requires.
- **Push pokes, pull data.** SSE events carry durable cursors and act as invalidation signals;
  clients re-pull through the paginated read API (Section 8). The server never streams
  authoritative state that cannot be re-fetched.

## 8. Web Console Architecture

Per TECH_STACK §3, with these structural rules:

- **URL is the source of truth** for shareable filters, tabs, pagination, and history ranges
  (TanStack Router search params). TanStack Query owns all fetched server state, keyed by the
  generated client's resource identity; SSE pokes invalidate queries. React component state holds
  only ephemeral presentation state. A second client-side store of durable records is prohibited.
- **Generated client only.** All data access goes through the client generated from the OpenAPI
  contract; hand-written fetch calls to the Control API are prohibited.
- **Source-owned components.** shadcn/ui + Tailwind provide the accessible component base; view
  modules compose them and render presenter payloads. Views MUST NOT re-derive facts the presenter
  already computed.
- Mutations are ordinary authenticated HTTP requests carrying `expected_version` and idempotency
  keys; failed mutations preserve submitted values and structured errors (SPEC §14.3).

## 9. CI/CD Architecture

Delivery is part of the architecture: the pipeline is the only path by which behavior reaches
`main`, artifacts, and releases (CICD.md is normative; this section fixes structure).

- **One definition of correctness.** `make verify` composes every gate; workflow YAML coordinates
  jobs, permissions, and artifact movement and MUST NOT restate build or test logic (CICD §3).
  Every CI job body is a Make target runnable identically on a contributor host.
- **Workflow topology.** Four workflows, separating reusable verification from trigger-specific
  authority: `ci.yml` (pull_request, merge_group, push to main — untrusted, read-only token),
  `codeql.yml` (analysis + schedule), `publish-container.yml` (verified `main` commits only:
  build-once, publish OCI image by digest, SBOM, provenance attestation), and `release.yml`
  (promote existing digests for version tags; never rebuild). Trust increases monotonically
  across that list; permissions are granted per job, never per workflow.
- **The gate ladder mirrors the package structure.** Static verification (Biome, `tsc`,
  dependency-graph and boundary checks, generated-artifact drift) → unit/contract suites
  (domain and presenters, deterministic time) → scenario conformance suite (Section 10, memory
  adapters, real temporary SQLite) → persistence/process integration (real migrations, process
  trees, symlink escapes; Linux + macOS) → production build + Playwright against the built
  server → container build, non-root runtime check, Trivy scan. Each rung tests exactly the
  boundary the previous rung faked.
- **Evidence is exact-head.** Conformance reporting (SPEC §19) consumes only same-invocation
  results bound to the exact commit; prose, file existence, and stale runs are not evidence.
- **Branch protection is part of the design.** `main` requires the stable `ci / required`
  aggregate check, resolved conversations, squash-only merges with Conventional Commit titles,
  and no force pushes. A workflow refactor MUST update the ruleset in the same administrative
  change.

## 10. Testing Architecture

Test layers map one-to-one onto architectural boundaries; each layer fakes exactly one boundary
and proves the layer beneath it.

1. **Pure unit tests** — `domain` policies and `observability` presenters. Exhaustive,
   table-driven, mutation-tested first.
2. **Command-handler tests** — `persistence/commands` against real temporary SQLite with
   production migrations. Prove atomicity, uniqueness, and idempotency-key semantics. Mocked
   query builders are prohibited as the only evidence (TECH_STACK §6).
3. **Scenario conformance harness** — the keystone layer. `test-support/scenario` boots the
   *entire daemon* (kernel, lifecycle, persistence, real temporary SQLite) on memory adapters and
   a fake clock, then drives it through scripted tracker/agent behavior. Every SPEC §19.2 Core
   case MUST be exactly one scenario test, named by its case ID from
   `contracts/conformance`. Restart recovery is tested by stopping and re-booting the daemon on
   the same database mid-scenario.
4. **Adapter contract fixtures** — one shared fixture suite per adapter family, run against both
   memory and real implementations (record/replay or sandboxed live where feasible).
5. **Boundary integration** — process trees, sandbox escapes, signal handling, on Linux and
   macOS runners.
6. **Production-build browser tests** — Playwright against the built Fastify server serving the
   built UI: bootstrap, dashboard, history, live-log reconnection, stale-version rejection,
   authorization failure, hostile-content rendering.
7. **Live E2E profile (Real Integration, SPEC §19.3)** — a containerized, opt-in harness
   (docker-compose, throwaway repository and tracker project, real credentials from the host
   environment) runnable as one Make target. It MUST exist as code in the repository, not as a
   manual runbook.

## 11. Prohibited Structures

These anti-patterns are architectural defects; repository policy checks SHOULD detect them where
statically visible.

- Orchestration, lifecycle, review, merge, budget, or recovery logic under `apps/server`.
- Module or file names encoding lifecycle phase × role combinations (`initial-*-planner`,
  `continuation-*-executor`, …); the lifecycle machine plus role strategies is the only home.
- Untyped persistence: `Record<string, unknown>` table schemas, stringly-typed rows, or
  repositories bypassed by inline SQL in feature code.
- More than one implementation of a SPEC §19.4 algorithm; more than one worker exit path; more
  than one definition of a CI gate.
- Decisions read from process logs, tracker comments, humanized strings, or provider-specific
  payloads (only normalized events cross the agent-adapter boundary).
- A second client-side store of durable records in the web console; hand-written Control API
  calls bypassing the generated client.
- Direct database writes from the UI, API handlers, or scripts — all mutations route through
  command handlers, and all external mutations through the outbox.
- Blocking the kernel loop on adapter I/O, subprocess completion, or unbounded synchronous work.

## 12. Change Governance

- Structural deviations from this document, replacement of a mandated pattern, adoption of a
  deferred technology (TECH_STACK §12), or a new top-level package REQUIRE an architecture
  decision record under `docs/adr/`, stating the measured requirement, the options considered,
  the migration path for durable state, and the conformance evidence plan.
- This document MUST be updated in the same pull request as any change it would otherwise
  misdescribe. `SPEC.md`, `TECH_STACK.md`, and `CICD.md` remain the behavioral, stack, and
  delivery contracts; this document never overrides them.

## 13. Non-Normative: Design Lineage

The coordination-core shape (Sections 1 and 4) is adapted from the Symphony Elixir reference
implementation (`openai/symphony`), which demonstrates the same problem solved with one GenServer
mailbox, crash-only monitored workers, timer tokens, a single snapshot feeding all observability
surfaces, and configuration read at the tick boundary. Encore's stronger spec adds what that
implementation deliberately omitted — a durable single-writer store, enforced budgets, review and
merge gates, orchestrator-owned external mutations, and an authenticated control plane — and this
architecture is the composition of both: the Elixir implementation's coordination shape around the
Encore specification's durability and authority model. Named patterns used here, for reference:
Hexagonal Architecture (ports and adapters), Functional Core / Imperative Shell, Single-Writer
Actor (run-to-completion event loop), State Machine + Strategy (attempt lifecycle), Policy as Data
(interpreted decision tables), Unit of Work (transactional command handlers), Transactional Outbox
(intent/receipt), Repository with typed row mappers, Read Model / Presenter projections,
Composition Root, Optimistic Concurrency (`expected_version`), and Idempotency Keys end to end.
