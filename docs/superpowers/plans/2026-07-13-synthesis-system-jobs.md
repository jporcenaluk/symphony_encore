# Synthesis SystemJobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Section 12 synthesis lifecycle from durable trigger inputs through a typed
deep-profile SystemJob, independent verification/review, supervised merge, and terminal result.

**Architecture:** Extend the existing first-class SystemJob pipeline rather than creating a second
scheduler. A focused persistence module owns trigger/context snapshots and synthesis result closure;
focused server modules own planning and execution. Proposal results enter the existing verification,
publication, review, merge, and post-merge gates with `system_job` work references, while
`no_change` and `needs_input` close or park atomically without repository side effects.

**Tech Stack:** TypeScript, TypeBox contracts, Kysely/better-sqlite3 transactions, Vitest, existing
agent/workspace/repository adapters, production scheduler.

---

## Task 1: Durable synthesis queue and input snapshot

**Files:**

- Modify: `packages/persistence/src/system-job-store.ts`
- Modify: `packages/persistence/src/system-job-store.test.ts`
- Create: `packages/persistence/src/synthesis-store.ts`
- Create: `packages/persistence/src/synthesis-store.test.ts`

- [ ] Write a failing persistence test proving interval counts are measured after the latest
  terminal synthesis, only one active synthesis is queued, and the queue transaction also writes
  the `queued` StageTransition and `system_job_dispatch_required` Ready claim.
- [ ] Add `loadSynthesisTriggerState` queries for completed issue count, active synthesis count,
  lessons since the last terminal synthesis, current rules, per-class/role usage aggregates, and
  decayed rule ids.
- [ ] Change `queueSynthesisSystemJob` to atomically create the job, baseline stage, and Ready claim;
  require service-run holder and transition identity inputs.
- [ ] Run `pnpm exec vitest run packages/persistence/src/system-job-store.test.ts packages/persistence/src/synthesis-store.test.ts` and expect all tests to pass.
- [ ] Commit with `feat(synthesis): queue durable synthesis inputs`.

## Task 2: Deep synthesis attempt planning and execution

**Files:**

- Create: `apps/server/src/initial-synthesis-attempt-planner.ts`
- Create: `apps/server/src/initial-synthesis-attempt-planner.test.ts`
- Create: `apps/server/src/initial-synthesis-attempt-lifecycle.ts`
- Create: `apps/server/src/initial-synthesis-attempt-lifecycle.test.ts`

- [ ] Write a failing planner test proving the role is `synthesis`, profile is `deep`, the attempt
  uses SystemJob/fleet budgets, and the prompt contains only durable lessons/rules/metrics plus hard
  saturation caps and decayed-rule candidates.
- [ ] Implement preflight-first planning with `SynthesisResultSchema`, the pinned configuration
  snapshot, SystemJob workspace, and `queued → running` dispatch transition.
- [ ] Write a failing lifecycle test proving dispatch is committed before workspace population and
  agent launch, and that session usage is charged through the shared consumer.
- [ ] Implement lifecycle launch with the existing SystemJob workspace manager and process binding.
- [ ] Run both synthesis attempt test files and expect all tests to pass.
- [ ] Commit with `feat(synthesis): execute deep synthesis attempts`.

## Task 3: Atomic typed synthesis result closure

**Files:**

- Create: `packages/persistence/src/synthesis-finish-store.ts`
- Create: `packages/persistence/src/synthesis-finish-store.test.ts`
- Create: `apps/server/src/synthesis-attempt-closure.ts`
- Create: `apps/server/src/synthesis-attempt-closure.test.ts`

- [ ] Write failing tests for `no_change`, `needs_input`, invalid lesson citations, saturation
  violations, and `propose_changes` targeting a repository revision different from workspace HEAD.
- [ ] Validate every cited lesson and `RuleChange` with `validateRuleChanges`; reject evidence-free
  or over-cap proposals before advancing work.
- [ ] Atomically close `no_change` as `done`; park `needs_input` as `human` with an
  OperatorQuestion/ParkedWork record; route a valid proposal to `review` with
  `synthesis_verification_required`.
- [ ] Normalize stream/protocol/process failures through bounded retry or human routing using the
  same budget settlement invariants as repair attempts.
- [ ] Run both closure test files and expect all tests to pass.
- [ ] Commit with `feat(synthesis): close typed synthesis outcomes`.

## Task 4: Proposal verification and repository publication

**Files:**

- Modify: `packages/adapters/src/contracts.ts`
- Modify: `packages/adapters/src/github-repository-transport.ts`
- Modify: `packages/adapters/src/github-repository-transport.test.ts`
- Modify: `packages/persistence/src/verification-store.ts`
- Modify: `apps/server/src/independent-verification-runner.ts`
- Modify: `apps/server/src/repository-publication.ts`
- Modify: `apps/server/src/repository-publication.test.ts`

- [ ] Write failing adapter tests for deterministic `symphony/system-synthesis-<short-id>` branches
  distinct from repair branches.
- [ ] Add an explicit SystemJob kind to the branch-publication adapter request without changing the
  durable `WorkRef` contract; keep issue publication backward compatible.
- [ ] Write failing verification tests that recover a closed synthesis proposal result and pin the
  verification record to its reported repository revision and actual workspace HEAD.
- [ ] Add synthesis verification recovery and route pass to `pull_request_required`, failure to
  `synthesis_rework`/human according to bounded retry policy.
- [ ] Write failing publication tests for branch receipt, ordinary SystemJob PR receipt,
  RepositoryLink persistence, and `pull_request_hygiene_required` without tracker mutation.
- [ ] Implement the synthesis publication coordinator with exact revision checks and supervised PR
  metadata from the typed result.
- [ ] Run the adapter, verification, and publication test files and expect all tests to pass.
- [ ] Commit with `feat(synthesis): publish verified synthesis proposals`.

## Task 5: Shared review, merge, and scheduler integration

**Files:**

- Modify: `apps/server/src/integrative-review-attempt-planner.ts`
- Modify: `apps/server/src/integrative-review-attempt-executor.ts`
- Modify: `apps/server/src/integrative-review-attempt-closure.ts`
- Modify: `apps/server/src/adjudication-attempt-closure.ts`
- Modify: `apps/server/src/production-scheduler.ts`
- Modify: `apps/server/src/production-scheduler.test.ts`

- [ ] Write a failing scheduler test that queues an interval-triggered synthesis, executes its deep
  attempt, verifies and publishes a proposal, runs fresh review, requires operator merge approval,
  lands the PR, passes post-merge checks, and marks the SystemJob `done` without tracker calls.
- [ ] Generalize review work types from repair-only SystemJobs to all SystemJobs while preserving
  specialist selection and adjudication invariants.
- [ ] Reconcile synthesis triggers before candidate dispatch each tick and route every synthesis
  Ready reason through the existing global slot and repository-merge serialization controls.
- [ ] Reuse current-head hygiene, immutable ReviewSet, merge queue, and SystemJob post-merge success
  paths; reject any attempt to synthesize a tracker lane.
- [ ] Add a `no_change` scheduler case and a `needs_input` case proving no repository mutation.
- [ ] Run `pnpm exec vitest run apps/server/src/production-scheduler.test.ts` and expect all tests to pass.
- [ ] Commit with `feat(synthesis): integrate supervised synthesis lifecycle`.

## Task 6: Ledger and canonical verification

**Files:**

- Modify: `IMPLEMENTATION_STATUS.md`

- [ ] Update S05, S07, S08, S10, S11, S12, and S13 only where current tests provide direct proof.
- [ ] Run `make verify-fast`; expect lint, Markdown, repository policy, contract/OpenAPI drift,
  typecheck, and every Vitest file to pass.
- [ ] Run `make build`; expect every workspace package and the production web bundle to build.
- [ ] Run `git diff --check`; expect no output.
- [ ] Commit with `docs(status): record synthesis lifecycle evidence`.
