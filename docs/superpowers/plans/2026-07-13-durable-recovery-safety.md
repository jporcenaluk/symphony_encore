# Durable Recovery and Mutation Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development, superpowers:test-driven-development, and
> superpowers:systematic-debugging for every unexpected failure. Every slice receives separate
> specification-compliance and code-quality review.

**Goal:** Enforce one lifetime-exclusive writer, recover all durable and provider state before
readiness, and make every privileged external mutation fail closed on authorization or persistence
uncertainty.

**Architecture:** A platform adapter acquires a canonical-path OS lock before SQLite is opened. A
durable monotonically increasing fencing epoch rejects stale writers after open. One startup
coordinator reconstructs and reconciles all state before enabling dispatch or mutations. One
provider-mutation application service owns authorization, intent, health recheck, adapter call,
receipt, and uncertain-result reconciliation for current callers before later extraction.

**Tech Stack:** Node.js platform/process/filesystem APIs, SQLite/Kysely, strict TypeScript, Vitest,
real subprocess fixtures, GitHub adapter contracts.

---

## Preconditions

- [ ] W0 and W1a are committed and green.
- [ ] The exact lock mechanism for Linux/WSL and macOS has a written portability note in code/docs.
- [ ] Implementers receive disjoint ownership for lock/fence, startup recovery, or mutation kernel.
- [ ] No production edit begins without a failing test observed by its implementer.

## Task 1: Define canonical store identity and OS lock contract

**Files:**

- Create: `packages/adapters/src/service-lock.ts`
- Create: `packages/adapters/src/service-lock.test.ts`
- Create: platform implementations and real-process fixtures under `packages/adapters/src/`
- Modify: `packages/adapters/src/index.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/service-runtime.ts`

- [ ] Write failing real-process tests for two owners using the same direct path, a relative/absolute
  alias, and a symlink alias.
- [ ] Write failing tests for non-reentrancy, normal release, process crash, stale lock recovery, and
  an unsupported platform.
- [ ] Resolve the durable-store identity without opening or creating SQLite/WAL files.
- [ ] Acquire the lock before database open/migrations and hold it until workers stop, mutation
  activity drains, the database closes, and shutdown completes.
- [ ] Produce typed lock identity/owner diagnostics without leaking secrets.
- [ ] Run real-process lock tests repeatedly and the focused server lifecycle suite.
- [ ] Commit with `feat(recovery): acquire exclusive store lock before SQLite`.

## Task 2: Add durable fencing

**Files:**

- Create: `packages/persistence/src/service-fence-store.ts`
- Create: `packages/persistence/src/service-fence-store.test.ts`
- Modify: the active schema/migration boundary under `packages/persistence/src/`
- Modify: migration fresh/upgrade/checksum tests
- Modify: `packages/persistence/src/service-run-store.ts`

- [ ] Add failing tests for monotonic epochs, service-run binding, stale writer rejection, rollback,
  restart, and upgrade from every supported database version.
- [ ] Add an immutable migration for the fence record and bind each live `ServiceRun` to its epoch.
- [ ] Require the expected epoch on privileged write transactions and reject older owners.
- [ ] Preserve migration history/checksums and prove fresh/upgrade/reopen behavior.
- [ ] Commit with `feat(persistence): fence stale service writers`.

## Task 3: Build one fail-closed startup coordinator

**Files:**

- Create: `packages/orchestration/src/startup/coordinator.ts`
- Create: `packages/orchestration/src/startup/coordinator.test.ts`
- Modify: `apps/server/src/startup-recovery.ts`
- Modify: `apps/server/src/corrupt-store-recovery.ts`
- Modify: `apps/server/src/service-runtime.ts`
- Modify: process/workspace/scheduler stores as required by missing reconstruction reads

- [ ] Write a failing order test for configuration validation; claims, attempts, sessions, retries,
  questions, stages, budgets, workspaces, and intents; process verification; provider reconciliation;
  closure/settlement; timer/budget rebuild; quarantine; durable recovery result; readiness.
- [ ] Add failure cases at every boundary proving dispatch and mutation remain disabled.
- [ ] Unify normal and corrupt-store recovery around shared typed steps while preserving their
  distinct authorization rules.
- [ ] Bind the recovery result to lock identity, fencing epoch, configuration snapshot, and provider
  observations.
- [ ] Run startup, service runtime, process, workspace, budget, and configuration suites.

## Task 4: Reconcile every unresolved external intent before readiness

**Files:**

- Create: `packages/orchestration/src/startup/intent-reconciliation.ts`
- Create: `packages/orchestration/src/startup/intent-reconciliation.test.ts`
- Modify: provider adapter contracts under `packages/adapters/src/contracts.ts`
- Modify: GitHub tracker/repository adapters and side-effect persistence modules
- Modify: `apps/server/src/main.ts`

- [ ] Inventory every tracker, branch, PR, merge, notification, and control-triggered external
  mutation kind.
- [ ] Replace unrestricted intent action strings with a closed mutation-kind registry that binds
  each kind to its observation/reconciliation handler.
- [ ] Add a completeness test that prevents creation/application of a new intent kind until its
  handler and full crash-window fixtures are registered; W7/W8 extensions must extend this registry.
- [ ] Add fixtures for committed-only, applying/unobserved, applied/unreceipted, received, conflicting,
  and provider-unavailable crash windows for every kind.
- [ ] Query by idempotency key or exact observed state without issuing a new mutation.
- [ ] Commit a receipt only when observed state proves the intended result; otherwise keep the service
  fail closed with an operator-visible durable reason.
- [ ] Prove repeated startup reconciliation is idempotent.
- [ ] Commit Tasks 3-4 with `feat(recovery): reconcile durable state before readiness`.

## Task 5: Implement the privileged provider-mutation kernel

**Files:**

- Create: `packages/orchestration/src/mutations/provider-mutation.ts`
- Create: `packages/orchestration/src/mutations/provider-mutation.test.ts`
- Modify: `packages/orchestration/src/scheduler/persistence-safety.ts`
- Modify: every current mutating provider caller under `apps/server/src/`
- Modify: provider authorization/side-effect stores as required

- [ ] Write the authorization mismatch matrix first: actor, role, capability, action, provider,
  project/repository/work scope, target revision, expiry, and fencing epoch.
- [ ] Write failure-interleaving cases before intent, after intent, before health recheck, immediately
  before adapter call, after provider success, before receipt, and after receipt.
- [ ] Centralize exact authorization validation, applying intent, persistence-health/fence recheck,
  adapter invocation, receipt commit, and uncertain-result classification.
- [ ] Move every current direct provider mutation caller onto the kernel before W1b moves files.
- [ ] Add a source-level repository-policy test rejecting direct mutable adapter calls outside the
  kernel and approved adapter implementations.
- [ ] Run tracker, repository publication, merge, repair, synthesis, control, and recovery suites.
- [ ] Commit with `feat(safety): mediate every privileged provider mutation`.

## Task 6: Stop unsafe work on persistence failure

**Files:**

- Modify: `packages/orchestration/src/scheduler/persistence-safety.ts`
- Modify: `apps/server/src/service-runtime.ts`
- Modify: `apps/server/src/agent-event-consumer.ts`
- Modify: running reconciliation and attempt-session paths

- [ ] Add real/fake interleaving tests for lease renewal, usage accounting, terminal-result commit,
  intent/receipt commit, and durable recovery-result failure.
- [ ] Latch the first unsafe persistence failure, reject new dispatch/mutations, cancel and terminate
  affected process trees, and preserve the first diagnostic.
- [ ] Distinguish safe provider observation refresh failures from unsafe durable-write failures.
- [ ] Prove no new adapter call starts after the latch; cancel cancellable in-flight calls, classify
  non-cancellable calls as uncertain, never retry them blindly, and reconcile them during restart
  before the latch clears.
- [ ] Run focused fault suites repeatedly, then `make verify-fast`, integration, and build.
- [ ] Commit with `feat(safety): stop workers on persistence uncertainty`.

## Workstream exit criteria

- [ ] Two real service processes cannot own one database through any tested path alias.
- [ ] Lock ownership begins before SQLite access and ends after database close.
- [ ] Stale fenced writers cannot commit privileged transitions or mutations.
- [ ] Every unresolved intent kind is reconciled before readiness without blind replay.
- [ ] Every current provider mutation uses the kernel and the repository-policy test enforces it.
- [ ] Every persistence-failure interleaving fails closed and terminates unsafe workers.
- [ ] Separate spec and quality reviewers approve every task.
- [ ] `make verify-fast`, `make test-integration`, and `make build` pass.
- [ ] Traceability/status rows are updated only from passing evidence.
