# Orchestration Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development and superpowers:test-driven-development. Every task needs
> separate specification-compliance and code-quality review.

**Goal:** Introduce deterministic runtime seams before safety hardening, then move scheduler,
attempt, publication, merge, and persistence responsibilities to their normative layers after the
W2 recovery and privileged-mutation kernel is green.

**Architecture:** `W1a` is characterization and dependency injection only; it must not move or
normalize unsafe provider calls. `W1b` starts only after W2 and extracts already-hardened behavior
into `packages/orchestration`, leaving `apps/server` as composition, HTTP/static serving, readiness,
and signal lifecycle. Typed persistence and immutable migration modules replace untyped table maps
without changing durable semantics.

**Tech Stack:** strict TypeScript, Vitest, Kysely, better-sqlite3, Node.js process/filesystem ports.

---

## Preconditions

- [ ] W0 traceability, evidence infrastructure, and clean-runner baseline are committed.
- [ ] The main agent assigns disjoint file ownership and no implementer commits or pushes.
- [ ] Before each extraction, characterization tests pass and identify every caller and Ready reason.
- [ ] Tasks 3-6 are blocked until the W2 plan is committed, implemented, and reviewed green.

## W1a Task 1: Characterize nondeterministic runtime behavior

**Files:**

- Modify: `apps/server/src/production-scheduler.test.ts`
- Modify: focused retry, reconciliation, publication, and merge tests under `apps/server/src/`
- Create: `packages/orchestration/src/runtime-services.test.ts`

- [ ] Add failing/characterization cases for wall time, monotonic elapsed time, IDs, retry jitter,
  process launch, filesystem checks, provider observation, and persistence-health reads.
- [ ] Identify every orchestration use of `Date`, `Date.now`, `randomUUID`, `Math.random`, direct
  process launch, and direct filesystem access.
- [ ] Record observable ordering and durable values without locking tests to private helper calls.
- [ ] Run the smallest focused Vitest selectors and confirm characterization failures are understood.

## W1a Task 2: Add deterministic runtime ports

**Files:**

- Create: `packages/orchestration/src/runtime-services.ts`
- Modify: `packages/orchestration/src/index.ts`
- Create: `packages/test-support/src/runtime-services.ts`
- Modify: `packages/test-support/src/index.ts`
- Modify: current orchestration callers in `apps/server/src/` only as needed for injection

- [ ] Define `Clock`, `IdentifierSource`, `JitterSource`, `ProcessLauncher`,
  `FileSystemBoundary`, provider observation ports, and `PersistenceHealth`.
- [ ] Supply production adapters at the composition root and deterministic fakes in test support.
- [ ] Replace direct nondeterminism incrementally, one failing characterization at a time.
- [ ] Keep provider mutation calls in their current files until W2 hardens them.
- [ ] Run focused tests, package typechecks, `make verify-fast`, and `make build`.
- [ ] Commit with `refactor(orchestration): inject deterministic runtime services`.

## W1a exit criteria

- [ ] Scheduler/retry tests no longer monkey-patch global time, UUID, or random functions.
- [ ] Runtime effects enter orchestration through typed ports.
- [ ] No provider mutation, lifecycle route, or package responsibility moved yet.

## W1b Task 3: Extract one attempt-session runner

**Execution gate:** W2 lock, startup recovery, and provider-mutation tasks must be green.

**Files:**

- Create: `packages/orchestration/src/attempts/session-runner.ts`
- Create: `packages/orchestration/src/attempts/session-runner.test.ts`
- Modify: role executors and closures under `apps/server/src/`
- Modify: `packages/orchestration/src/index.ts`

- [ ] Characterize launch, consume, hard-cap cancellation, terminal-result validation, process-tree
  termination, durable close, usage settlement, and claim routing for every role.
- [ ] Write failing tests for exactly-once close and the role-specific close strategy interface.
- [ ] Extract the common runner without changing role result schemas or routing outcomes.
- [ ] Remove duplicated consume/cancel/close sequences only after each role uses the runner.
- [ ] Run all attempt/closure/consumer tests, package typechecks, and `make verify-fast`.
- [ ] Commit with `refactor(orchestration): centralize attempt session lifecycle`.

## W1b Task 4: Extract the scheduler shell and fail-closed Ready registry

**Files:**

- Create: `packages/orchestration/src/scheduler/production-scheduler.ts`
- Create: `packages/orchestration/src/scheduler/production-scheduler.test.ts`
- Create: `packages/orchestration/src/scheduler/ready-handler-registry.ts`
- Create: `packages/orchestration/src/scheduler/ready-handler-registry.test.ts`
- Modify: `apps/server/src/production-scheduler.ts`
- Modify: `apps/server/src/service-runtime.ts`

- [ ] Enumerate every persisted Ready reason and write a failing registry-completeness test.
- [ ] Prove unknown, duplicate, or unhandled reasons fail closed with a durable operator-visible
  outcome rather than retaining a stranded claim.
- [ ] Preserve the characterized poll order while moving the shell; Task E1/W5 owns the intentional
  behavior change to one normative production/test poll algorithm and complete human reconciliation.
- [ ] Move scheduling policy and handler dispatch to orchestration; leave concrete adapter wiring and
  service start/stop in server.
- [ ] Add a repository-policy boundary test that rejects scheduler policy in `apps/server`.
- [ ] Run scheduler/reconciliation tests, server/orchestration tests, typechecks, fast gate, and build.
- [ ] Commit with `refactor(orchestration): extract canonical scheduler`.

The unknown-Ready-reason failure is an intentional safety change in W1b and receives its own failing
test and review. Other scheduler behavior remains structural until W5.

## W1b Task 5: Extract publication and merge coordinators

**Files:**

- Create: `packages/orchestration/src/publication/coordinator.ts`
- Create: `packages/orchestration/src/publication/coordinator.test.ts`
- Create: `packages/orchestration/src/merge/coordinator.ts`
- Create: `packages/orchestration/src/merge/coordinator.test.ts`
- Modify: `apps/server/src/repository-publication.ts`
- Modify: `apps/server/src/merge-queue.ts`
- Modify: `apps/server/src/service-runtime.ts`

- [ ] Characterize branch/PR/update/merge/post-merge/repair flows at exact revision and identity.
- [ ] Require the W2 provider-mutation service for every external mutation before moving any caller.
- [ ] Write failing package-boundary tests preventing direct mutable adapter use from server routes or
  scheduler handlers.
- [ ] Move orchestration decisions and transactions; retain concrete GitHub construction in server.
- [ ] Run publication, merge, repair, synthesis, provider-mutation, and scheduler suites.
- [ ] Commit in narrow behavior-preserving slices, ending with
  `refactor(orchestration): extract publication and merge coordinators`.

## W1b Task 6: Type persistence and isolate immutable migrations

**Files:**

- Create: `packages/persistence/src/schema.ts`
- Create: `packages/persistence/src/migrations/manifest.ts`
- Create: immutable modules under `packages/persistence/src/migrations/`
- Modify: `packages/persistence/src/database.ts`
- Modify: `packages/persistence/src/migrations.test.ts`
- Modify: row mappers and repositories under `packages/persistence/src/`

- [ ] Snapshot every current migration version, checksum, and SQL body in tests before extraction.
- [ ] Add exact Kysely interfaces for every table, JSON encoding, nullable field, and enum.
- [ ] Extract migrations without changing their SQL or historical checksum.
- [ ] Add fresh apply, upgrade from every supported version, repeat-open, future-version rejection,
  checksum rejection, and W2 fencing upgrade fixtures.
- [ ] Compile every repository/mapper against the typed schema; do not use broad
  `Record<string, unknown>` table types.
- [ ] Run all persistence tests, package typecheck, `make verify-fast`, and `make build`.
- [ ] Commit with `refactor(persistence): type schemas and isolate migrations`.

## Final review and evidence

- [ ] Specification reviewer confirms server/package ownership and no behavior loss.
- [ ] Code-quality reviewer confirms files have cohesive size, names, and dependency direction.
- [ ] Run `make verify-fast`, `make test-integration`, and `make build`.
- [ ] Update the traceability matrices and status ledger only from passing evidence.
- [ ] Record remaining large files and explain why each remaining responsibility is cohesive.
