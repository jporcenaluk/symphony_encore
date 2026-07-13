# Symphony Encore Completion Architecture

**Status:** Selected design for completing `SPEC.md`, `TECH_STACK.md`, and `CICD.md`

**Baseline revision:** `090cd6b818097e72524d462ab03208625a94155e`

**Pull request:** `#3` (`feat/symphony-encore-core` into `main`)

## 1. Purpose

This design turns the current greenfield vertical slice into a conforming, reviewable Symphony
Encore implementation. The top-level specification files remain normative. The status ledger and
conformance report are evidence projections; they do not define correctness.

The design follows four independent read-only reviews covering architecture, Core durability,
product and operational surfaces, and testing and delivery. All four reviews found substantial
implemented components, but none considered the current branch conforming or production-ready.

## 2. Verified baseline

At the baseline revision:

- `make verify-fast` passes 161 Vitest files and 581 tests.
- `make build` builds every workspace package and the production web bundle.
- PR `#3` is open as a draft and contains 403 files and 86,770 additions.
- CodeQL passed, but the main CI workflow failed on Linux, macOS, workflow lint, image smoke, and
  the aggregate required check.
- the legacy prose-driven Core report marked only `C-DUR-03` and `C-UI-04` complete; the corrected
  ledger retains only `C-DUR-03` as directly proven;
- the Real Integration Profile has not run;
- `production_ready` is false;
- Docker is unavailable in the current WSL environment;
- repository rules do not protect `main`, and merge commits and rebases remain enabled; and
- the local `gh` token is invalid, although the installed GitHub connector can read and mutate the
  repository within its granted permissions.

Running the incomplete conformance reporter also exposes an idempotency defect: it writes an
ignored JSON artifact that the next Biome run scans and rejects.

## 3. Consolidated architectural risks

### 3.1 Safety-critical gaps

The following gaps block production readiness regardless of test count:

1. The service does not acquire an exclusive durable writer lock. Two processes can operate the
   same database and providers concurrently.
2. Normal startup does not reconcile side-effect intents that may have been applied externally but
   lack a durable receipt.
3. Persistence health is not checked immediately before every privileged provider mutation.
4. Configuration overrides receive only shallow validation. Invalid values and literal secrets can
   be persisted as valid and reported as committed.
5. The Codex adapter ignores configured approval and sandbox posture, launches through `bash -c`,
   and does not use the deployment-enforced workspace and credential boundary used by hooks and
   verification.
6. Authenticated mutation rejections can return before an `OperatorAction` is recorded.
7. The conformance reporter can eventually claim success from ledger text without proving the
   fixed 35-case Core inventory or adapter status.

### 3.2 Responsibility and testability gaps

The workspace dependency graph is acyclic, but the responsibility graph is not aligned with
`TECH_STACK.md`:

- `apps/server/src/production-scheduler.ts` is a 2,645-line file whose main function spans more
  than 2,100 lines and owns nearly every orchestration lifecycle.
- merge, publication, retry, review, and scheduler application services live in `apps/server`
  instead of `packages/orchestration`.
- time, identifiers, and jitter use globals instead of explicit interfaces.
- attempt lifecycle mechanics are copied across roles.
- Kysely tables are typed as `Record<string, unknown>`, so table schemas, row mappers, and
  migrations are not checked together.
- all migrations live in one large database file.
- hot configuration reload stores a new snapshot but does not update the running scheduler.
- the pure poll-order implementation differs from the production poll loop.

### 3.3 Missing product surfaces

The Control API and web application are a vertical slice, not the required product. Missing or
incomplete areas include:

- complete operations, issue, run, history, budget, quality, notification, queue, and audit reads;
- session restore, logout, revocation, rate limiting, and rejection auditing;
- structured question answers, agent approvals, reminders, and first-answer-wins reconciliation;
- exact-candidate configuration acknowledgment and complete override source metadata;
- budget, autonomy, merge-queue, synthesis, retention, and refresh controls;
- durable log writes, queries, filtering, stage grouping, and live delivery;
- notifications with intents, receipts, retries, and delivery status;
- quality projections, sampled audits, escaped-defect demotion, and lessons;
- protected retention, deletion, holds, and tombstones; and
- the complete accessible dashboard, history, and settings journeys.

### 3.4 Missing lifecycle behavior

The current scheduler and stores also lack or incompletely compose:

- AwaitingHuman reconstruction and answer handling;
- valid consumption of lane-drift and eligibility-change Ready reasons;
- exactly-one terminal result enforcement;
- final-diff upward change reclassification;
- durable Guard Decisions and exact patch-identity review carry-forward;
- rolling fleet budgets, atomic top-ups, fan-out accounting, reset, and resume;
- provider retry-after and persistent-outage notification;
- sampled audits and the complete repair/learning feedback loop; and
- complete agent salvage and approval behavior.

### 3.5 Delivery gaps

The first remote run proved that authored workflow configuration is not delivery evidence:

- clean runners lack a bare `pnpm` shim when package scripts recursively invoke it;
- actionlint reports three shellcheck findings;
- the current PR title does not satisfy its own Conventional Commit gate;
- image smoke requires a package-owned native dependency from the deployment root;
- Playwright runs Vite preview with mocked APIs rather than the built Fastify application;
- coverage is neither collected nor enforced;
- `make verify` and CI implement different correctness graphs;
- Trivy, zizmor, Gitleaks, dependency review, publication, and release promotion remain unproven;
  and
- branch and tag governance required by `CICD.md` is not configured.

## 4. Refactoring approaches considered

### 4.1 Approach A: minimal containment in `apps/server`

Split the largest server files, inject runtime services, and deduplicate attempt lifecycles without
moving ownership between packages.

Advantages:

- lowest immediate code churn;
- fastest path to smaller files; and
- least import and build disruption.

Disadvantages:

- preserves the documented responsibility violation;
- leaves application services coupled to HTTP and process composition; and
- makes source-level architecture enforcement difficult.

This approach is rejected because it cannot honestly complete `T02` and `T05`.

### 4.2 Approach B: layer-aligned extraction and safety hardening

Move scheduler, recovery, review, publication, merge, budget, and control-mutation application
services into `packages/orchestration`. Keep `apps/server` as the composition root, Control API,
static host, and service lifecycle shell. Add explicit runtime interfaces and typed persistence
boundaries while preserving the existing domain model and durable schema.

Advantages:

- matches the normative package layout;
- creates deterministic test seams;
- permits safety controls to be centralized;
- preserves the useful existing implementation and migrations; and
- can be delivered as small behavior-preserving extractions followed by focused feature slices.

Disadvantages:

- moderate import and constructor churn;
- requires careful transaction and mutation-boundary characterization; and
- temporarily touches both old and new orchestration paths.

This is the selected approach.

### 4.3 Approach C: feature-sliced modular rewrite

Reorganize dispatch, planning, review, merge, repair, synthesis, and operator controls as separate
vertical modules containing their own application, persistence, and adapter code.

Advantages:

- strongest feature locality;
- natural ownership for a larger team; and
- easier future extraction into services.

Disadvantages:

- largest rewrite and migration risk;
- conflicts with the current normative package layout;
- duplicates cross-cutting durability mechanics unless carefully redesigned; and
- delays safety fixes behind structural work.

This approach is rejected as unnecessary for a single-process, single-project version 1.

## 5. Selected architecture

### 5.1 Package responsibilities

`packages/domain` owns pure policies and discriminated unions. It has no provider, persistence,
clock, filesystem, network, or process dependencies.

`packages/contracts` owns TypeBox wire and record schemas, the OpenAPI source contract, adapter
ports, and shared external identities. It does not import the concrete server application.

`packages/persistence` owns typed Kysely table interfaces, one immutable migration module per
version, row mappers, repositories, transaction helpers, the exclusive database/service lock, and
the persistence-health signal.

`packages/orchestration` owns application services:

- startup and recovery coordination;
- the canonical poll algorithm;
- Ready-claim handler registration and dispatch;
- attempt-session execution;
- planning, verification, review, publication, merge, repair, and synthesis coordination;
- rolling budget application services;
- live configuration state;
- the control-mutation kernel; and
- provider-intent application and reconciliation policy.

`packages/adapters` owns GitHub, Codex, Git/workspace, hook, verification, notification, sandbox,
filesystem, process, and platform implementations behind contracts. It does not decide lifecycle
transitions.

`packages/observability` owns Pino projection and durable event/log projection helpers. Durable
records are written before optional process telemetry.

`packages/test-support` owns fake clocks, deterministic identifiers and jitter, temporary migrated
databases, fake adapters, provider fixtures, conformance fixtures, and real-process helpers. It is
no longer an empty mandatory workspace.

`apps/server` owns composition, Fastify routes, static UI hosting, health/readiness, signal handling,
and construction of the selected concrete adapters. It does not contain scheduler policy or merge
application logic.

`apps/web` owns the Control API client experience. URL state owns shareable filters and selections;
TanStack Query owns server state; component state remains ephemeral.

### 5.2 Cross-cutting interfaces

All orchestration services receive a `RuntimeServices` aggregate containing:

- `Clock` for wall and monotonic time;
- `IdentifierSource` for durable IDs;
- `JitterSource` for bounded retry jitter;
- `ProcessLauncher`;
- `FileSystemBoundary`;
- the selected provider ports; and
- `PersistenceHealth`.

Production adapters implement these interfaces. Tests use deterministic fakes without global
monkey-patching.

`WorkRef` and repository identity have one canonical internal representation. Conversion to wire
contracts happens only at boundaries.

### 5.3 Canonical startup flow

1. Resolve and canonicalize the configured database path without opening SQLite.
2. Acquire a non-reentrant OS-level exclusive lock for that canonical store path before touching the
   database, WAL, or migrations. Hold it through worker shutdown and database close.
3. Open SQLite, apply and verify immutable migrations, and persist a new fencing epoch plus
   `ServiceRun` identity. Every privileged writer rejects a stale epoch.
4. Resolve and fully validate configuration without persisting secret values.
5. Enter recovering/read-only mode.
6. Load claims, attempts, sessions, retries, questions, stages, budgets, workspaces, and unresolved
   side-effect intents.
7. Verify or terminate process ownership.
8. Reconcile every unresolved provider intent by idempotency key without issuing a new mutation.
9. Close interrupted work, settle usage, rebuild timers and rolling budgets, and quarantine unsafe
   workspaces.
10. Publish a durable recovery result bound to the lock identity and fencing epoch.
11. Enable the authenticated mutation kernel and canonical scheduler only after every required
    recovery step succeeds.

Failure before step 11 leaves external mutations and dispatch disabled.

Lock acquisition is keyed by the resolved database identity, so symlink and path aliases cannot
create independent owners. Crash recovery and stale lock handling are platform-specific adapter
responsibilities and are tested with two real processes, not two connections in one process.

### 5.4 Canonical poll flow

One production algorithm, shared with deterministic tests, performs the normative order:

1. refresh provider observations;
2. persist observations;
3. reconcile terminal and lane state;
4. reconcile running attempts and lease ownership;
5. reconcile AwaitingHuman questions, approvals, reminders, and answers;
6. promote due retries and rebuild eligible Ready claims;
7. reconcile synthesis triggers;
8. dispatch Ready claims through a typed handler registry subject to slots, budgets, and repository
   serialization; and
9. emit one durable tick result.

Every Ready reason is either registered with exactly one handler or fails closed with an
operator-visible durable reason. Production and test order cannot diverge.

### 5.5 Privileged mutation flow

Every external mutation uses one application service:

1. require healthy persistence and a valid service lock;
2. load current work, configuration, observed external state, and target revision;
3. validate `MutationAuthorization` including actor, role, capability, scope, expiry, and revision;
4. transactionally write the `OperatorAction` when applicable and the `SideEffectIntent`;
5. recheck persistence health immediately before the adapter call;
6. apply through the typed adapter;
7. persist the receipt and observed revision; and
8. reconcile uncertain completion by idempotency key before any retry.

No provider adapter may be called directly from a route, scheduler branch, or UI-specific handler.

### 5.6 Control mutation kernel

All authenticated mutations share one kernel that performs, in order:

- session authentication and current operator lookup;
- same-origin and CSRF validation;
- capability authorization;
- expected-version validation;
- scoped idempotency-key and request-hash handling;
- complete typed and cross-field validation;
- durable recording of every authenticated acceptance or rejection;
- atomic internal state changes; and
- optional external intent creation through the privileged mutation flow.

Configuration overrides are fully resolved against defaults, workflow values, adapter capabilities,
secret-reference rules, and cross-field constraints before an accepted record is committed.

### 5.7 Live configuration

A `ConfigurationManager` owns the last known good effective state and immutable snapshots.

- hot values atomically replace the state read by the next tick;
- attempt values are pinned only by newly created Attempts and SystemJobs;
- restart values remain pending until restart;
- `ack+` and file-originated `file-ack+` values remain pending until an exact-hash action; and
- invalid candidates remain visible but never become effective.

Scheduler services read the current hot state through the manager rather than capturing a startup
object forever.

### 5.8 Agent execution boundary

Agent launch requests carry resolved thread and turn approval policy, sandbox policy, model/profile,
workspace, configuration snapshot, and capability information. Startup preflight verifies them
against the live Codex manifest.

The real Codex process runs inside the same deployment-enforced workspace, environment, HOME,
credential, socket, and process-tree boundary required for hooks and verification. Provider-level
sandbox requests are defense in depth, not the sole boundary. Approval requests become durable
AwaitingHuman work and resume only after an authorized decision.

### 5.9 Typed persistence

Each durable table has a Kysely interface matching the migration and row mapper. Migration modules
are immutable and ordered by a central manifest. Tests migrate from every supported prior version,
verify checksums, and compile repositories against the typed schema.

Persistence stores may use parameterized raw SQL for SQLite invariants, but row shapes are not
declared as unconstrained `Record<string, unknown>`.

### 5.10 Product read models

The API exposes paginated read models before the web UI expands. Read models cover operations,
history, configuration, questions and approvals, budgets, quality, queues, notifications, logs,
usage, review, evidence, side effects, links, snapshots, and operator audit.

Durable LogRecords, Events, UsageSamples, and quality projections are written before SSE or Pino
projection. Retention changes and deletion use the mutation kernel and preserve protected records,
aggregates, and tombstones.

## 6. Test and evidence architecture

### 6.1 Conformance registry

The fixed 35 Core IDs live in a typed manifest. Each entry names its requirement, deterministic
test command or result artifact, required adapters, and evidence schema. The reporter rejects
unknown, missing, duplicate, skipped, stale-revision, partial-adapter, or failed evidence. Ledger
checkboxes are generated from evidence; they do not drive conformance.

The report writes repository-formatted JSON without making the next canonical gate fail.

### 6.2 Test layers

- pure policy tests cover every domain transition and failure route;
- application-service tests use deterministic runtime services and real temporary SQLite;
- shared adapter conformance fixtures run against every selected adapter;
- integration tests cover every migration path, transaction rollback, concurrent writer attempt,
  persistence-failure interleaving, process tree, filesystem escape, and restart crash window;
- production E2E starts the built Fastify server and built Vite assets without mocking the required
  Control API journeys;
- container tests exercise bootstrap, real runtime dependencies, dispatch boundaries, persistence,
  restart, shutdown, non-root, and read-only root behavior; and
- the Real Integration Profile records redacted GitHub, Codex, auth, UI, merge, repair, and restart
  evidence at one exact revision.

### 6.3 Coverage and mutation testing

CI collects complete Vitest coverage, publishes the report, and establishes a measured regression
floor. Coverage is diagnostic and cannot substitute for conformance.

The first StrykerJS campaign covers deterministic, safety-critical modules in `packages/domain` and
selected pure orchestration policies. Generated code, type-only files, migrations, platform/process
adapters, Fastify assembly, and React rendering are excluded initially with recorded reasons.

The initial campaign runs without a break threshold to establish a baseline and classify survivors.
The committed gate then uses the stronger of:

- the reviewed baseline minus at most five percentage points; or
- 60 percent.

The threshold ratchets to 75 and then 80 percent as high-value survivors are killed. Pure
authorization and lifecycle-transition modules target 90 percent. No surviving mutant may weaken
authorization, idempotency, budget caps, stage transitions, verification, merge safety, secret
handling, or persistence fail-closed behavior.

This staged threshold is selected over an immediate repository-wide 80 percent gate because a
premature global target would reward low-value tests and make native/process/platform mutants noisy.

## 7. Refactoring and implementation sequence

1. Repair the clean-runner CI baseline and harden the conformance harness so later evidence is
   trustworthy.
2. Add deterministic runtime services, canonical identities, shared test fixtures, and narrow
   characterization seams without moving provider mutations.
3. Add the pre-database OS service lock and fencing, complete startup reconciliation, persistence
   fail-closed gate, and privileged mutation application service.
4. Extract the common attempt-session runner, scheduler shell, Ready-handler registry,
   publication, and merge coordinators into `packages/orchestration` after they can depend on the
   hardened startup and mutation services.
5. Fully validate configuration changes, add the live configuration manager, and centralize control
   mutations and rejection audit.
6. Enforce the Codex posture and OS execution boundary, then implement durable approval handling.
7. Implement exactly-one results, final-diff reclassification, rolling budgets, Guard Decisions,
   review carry-forward, and complete recovery routes.
8. Complete lessons, notifications, sampled audits, quality metrics, durable logs, retention, and
   tombstones.
9. Add the complete Control API read and mutation resources.
10. Build the complete accessible UI journeys against those resources.
11. Align `make verify` and CI; add real production E2E, container proof, coverage, and mutation
    gates.
12. Configure repository governance, run every Core case, run the Real Integration Profile, prove
    publication and tag promotion, and update the exact-revision evidence ledger.

Each step is implemented as cohesive test-first commits. Structural extraction and new behavior are
separated where practical so regressions have a narrow cause.

## 8. Reviewability decision

PR `#3` remains a draft integration branch while the architecture and conformance work proceeds.
Its history will not be destructively rewritten merely to reduce the displayed file count.

Work is organized into dependency-ordered commits and review packets matching Section 7. Before the
PR is marked ready, the main agent will reassess whether GitHub review can provide credible assurance
over the complete greenfield seed. If not, the commits will be published as a non-destructive stacked
PR series with `#3` retained as the integration umbrella. No stack member may claim conformance for
evidence supplied only by a later member.

Generated contracts, tests, lockfiles, and runtime source remain separately summarized in review
evidence so raw line count is not treated as proof or risk dismissal.

## 9. Completion boundary

The implementation is complete only when:

- every top-level normative requirement is represented in the traceability registry;
- every `MUST` has passing direct evidence;
- every unsatisfied `SHOULD` has an explicit accepted justification;
- all 35 Core cases pass from fixed, exact-revision evidence;
- selected adapters are no longer partial or contract-only;
- the Real Integration Profile passes;
- `production_ready` is true;
- local, Linux, macOS, WSL, container, and remote delivery evidence is current;
- mutation thresholds and critical-survivor rules pass;
- repository and tag governance matches `CICD.md`;
- publication and promotion reuse the verified immutable artifact; and
- the final review has no unresolved critical or high finding.
