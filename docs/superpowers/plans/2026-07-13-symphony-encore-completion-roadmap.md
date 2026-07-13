# Symphony Encore Completion Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the greenfield Symphony Encore implementation conform to every normative requirement
in `SPEC.md`, `TECH_STACK.md`, and `CICD.md`, with exact-revision local, remote, mutation, Core, and
Real Integration evidence.

**Architecture:** Extract application orchestration from `apps/server` into
`packages/orchestration`, centralize startup recovery and privileged mutations, introduce explicit
runtime services and typed persistence, then complete the Control API, operator UI, delivery, and
conformance surfaces. Preserve the existing durable model and useful vertical slices while fixing
safety boundaries before adding breadth.

**Tech Stack:** Node.js 24, pnpm, strict TypeScript, Fastify, React/Vite/TanStack, TypeBox/OpenAPI,
SQLite/better-sqlite3/Kysely, Pino, Vitest, Playwright, Biome, StrykerJS, Docker, GitHub Actions.

---

## Program rules

- `SPEC.md`, `TECH_STACK.md`, and `CICD.md` remain normative.
- `IMPLEMENTATION_STATUS.md` and generated conformance reports project verified evidence; neither
  may declare behavior from prose or file existence alone.
- Every workstream receives its own detailed implementation plan and review before that workstream's
  production edits begin.
- Each behavior change starts with a failing test or external-state reproduction.
- Structural extraction and new behavior use separate commits where practical.
- The main agent owns cross-workstream decisions, integration review, and the master status.
- Sub-agents receive bounded, disjoint ownership and do not commit or push unless explicitly told.
- No workstream is complete until its focused evidence and the applicable wider gate pass.
- External controls are verified live at the exact current revision.

## Workstream map

| Code | Workstream | Depends on | Detailed plan |
|---|---|---|---|
| W0 | Traceability and trustworthy conformance | None | `docs/superpowers/plans/2026-07-13-evidence-and-ci-baseline.md` |
| W1a | Runtime services and characterization seams | W0 | `docs/superpowers/plans/2026-07-13-orchestration-extraction.md` |
| W2 | Exclusive writer, recovery, and mutation safety | W0, W1a | `docs/superpowers/plans/2026-07-13-durable-recovery-safety.md` |
| W1b | Layer-aligned scheduler/publication/merge extraction and typed persistence | W1a, W2 | `docs/superpowers/plans/2026-07-13-orchestration-extraction.md` |
| W3 | Configuration manager and control-mutation kernel | W1b, W2 | Planned: `2026-07-13-configuration-control-kernel.md` |
| W4 | Agent posture, sandbox, credentials, and approvals | W1b, W2, W3 | Planned: `2026-07-13-agent-security-boundary.md` |
| W5 | Canonical scheduler and human reconciliation | W1b, W2, W3 | Planned: `2026-07-13-canonical-scheduler.md` |
| W6 | Results, classification, budgets, review, and merge | W2, W5 | Planned: `2026-07-13-lifecycle-conformance.md` |
| W7 | Learning, logs, notifications, quality, and retention | W2, W3, W5, W6 | Planned: `2026-07-13-observability-learning-retention.md` |
| W8 | Complete Control API and read models | W2, W3, W6, W7 | Planned: `2026-07-13-control-api-completion.md` |
| W9 | Complete accessible operator UI | W8 | Planned: `2026-07-13-operator-ui-completion.md` |
| W10 | Canonical delivery, coverage, mutation, and governance | W0, W4, W8, W9 | Planned: `2026-07-13-delivery-quality-gates.md` |
| W11 | Core, Real Integration, publication, and release proof | W0-W10 | Planned: `2026-07-13-production-readiness-proof.md` |

`W0` completes when traceability, the trusted evidence producer/reporter, and the reproducible CI
baseline are truthful and green; it does not require all Core behaviors to be implemented. Core
cases retain their implementation owner in `W2`-`W9`, while `W0` owns evidence infrastructure and
`W11` aggregates final proof.

The safety-critical execution order is `W0` -> `W1a` -> `W2` -> `W1b` -> `W3`. Although later
sections describe related extraction tasks together for readability, publication, merge, and broad
scheduler extraction must not begin before the `W2` lock, recovery, and provider-mutation kernel
exist.

## Phase A: Evidence before implementation

### Task A1: Freeze the architecture decision

**Files:**

- Verify: `docs/superpowers/specs/2026-07-13-symphony-encore-completion-design.md`

- [x] Complete four independent read-only reviews covering architecture, Core durability, product
  surfaces, and delivery/testing.
- [x] Compare minimal containment, layer-aligned extraction, and feature-sliced rewrite.
- [x] Select and commit the layer-aligned extraction design.
- [x] Verify the design remains consistent with every traceability workstream after the matrices are
  complete.

### Task A2: Build exhaustive normative traceability

**Files:**

- Create: `docs/compliance/README.md`
- Create: `docs/compliance/spec-traceability.md`
- Create: `docs/compliance/tech-stack-traceability.md`
- Create: `docs/compliance/cicd-traceability.md`
- Modify: `IMPLEMENTATION_STATUS.md`

- [x] Assign a stable source-ordered ID to every inherited or explicit `MUST`, `MUST NOT`, and
  `SHOULD` requirement and to every schema, enum, transition, configuration table, required surface,
  adapter operation, normalized event/error mapping, and reference-algorithm invariant made
  normative by the documents.
- [x] Record source location, strength, status, implementation, direct evidence, remaining work,
  dependency, and workstream for every ID.
- [x] Reconcile duplicate or overlapping requirements without deleting their source identities.
- [x] Correct stale and overstated ledger claims identified by the reviews.
- [x] Record the exact baseline revision, local result, remote CI result, adapter status, and
  external repository state.
- [x] Run Markdownlint and `git diff --check`.
- [ ] Commit with `docs(compliance): establish normative traceability`.

### Task A3: Make conformance evidence trustworthy

**Files:**

- Create: `packages/contracts/src/conformance.ts`
- Create: `packages/contracts/src/conformance.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `scripts/conformance-report.ts`
- Modify: `scripts/conformance-report.test.ts`
- Modify: `IMPLEMENTATION_STATUS.md`

- [ ] Define the exact 35 Core IDs and evidence schema in a typed manifest.
- [ ] Define a separate machine-evidence mapping for every Section 1-18 normative matrix row and
  selected tracker, repository-host, agent, and authentication adapter.
- [ ] Write failing tests for unknown, missing, duplicate, skipped, stale-revision, partial-adapter,
  and failed evidence.
- [ ] Remove ledger text as the source of conformance truth.
- [ ] Write repository-formatted output that does not break a subsequent Biome run.
- [ ] Require a passed Real Integration report before `production_ready` can be true.
- [ ] Keep `core_conformance` false until the normative matrix, all 35 Core cases, and all selected
  adapter contracts have exact-revision passing evidence.
- [ ] Prove incomplete evidence exits nonzero without claiming Core.
- [ ] Commit with `feat(conformance): bind reports to executable evidence`.

## Phase B: Restore a reproducible delivery baseline

### Task B1: Repair clean-runner verification

**Files:**

- Modify: `Makefile`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/repository-policy.ts`
- Modify: `scripts/repository-policy.test.ts`
- Modify: `scripts/verify-container.sh`

- [ ] Reproduce the missing-pnpm-shim failure in an environment without a global pnpm binary.
- [ ] Establish the pinned Corepack shim in `make setup` and every clean CI runner.
- [ ] Fix SC2016, SC2035, and SC2251 without suppressing shellcheck.
- [ ] Replace the root-level `better-sqlite3` smoke import with an owned production boundary.
- [ ] Add repository-policy tests that prevent regression of the runner and workflow contract.
- [ ] Change PR `#3` to a Conventional Commit title before rerunning remote checks.
- [ ] Pass local fast/build gates and the remote Linux, macOS, supply-chain, image, CodeQL, and
  aggregate required jobs at the same head SHA.
- [ ] Commit with `fix(ci): restore clean-runner verification`.

## Phase C: Align the architecture

### Task C1: Introduce deterministic runtime services

**Files:**

- Create: `packages/orchestration/src/runtime-services.ts`
- Create: `packages/orchestration/src/runtime-services.test.ts`
- Create: `packages/test-support/src/runtime-services.ts`
- Modify: `packages/test-support/src/index.ts`
- Modify: `packages/orchestration/src/index.ts`
- Modify: `apps/server/src/production-scheduler.ts`

- [ ] Define clock, identifier, jitter, process, filesystem, provider, and persistence-health ports.
- [ ] Provide deterministic fake clock, ID sequence, and jitter implementations.
- [ ] Characterize scheduler time, ID, and retry behavior before replacing globals.
- [ ] Replace direct `Date`, `randomUUID`, and `Math.random` use in orchestration paths.
- [ ] Prove scheduler tests need no global monkey-patching.
- [ ] Commit with `refactor(orchestration): inject deterministic runtime services`.

### Task C2: Extract the canonical orchestration application layer

**Execution gate:** Do not begin this task until Tasks D1 and D2 pass. This is `W1b`, not part of the
pre-safety `W1a` foundation.

**Files:**

- Create: `packages/orchestration/src/scheduler/production-scheduler.ts`
- Create: `packages/orchestration/src/scheduler/ready-handler-registry.ts`
- Create: `packages/orchestration/src/attempts/session-runner.ts`
- Create: `packages/orchestration/src/publication/coordinator.ts`
- Create: `packages/orchestration/src/merge/coordinator.ts`
- Modify: `apps/server/src/production-scheduler.ts`
- Modify: `apps/server/src/merge-queue.ts`
- Modify: `apps/server/src/repository-publication.ts`
- Modify: `apps/server/src/service-runtime.ts`

- [ ] Characterize all current Ready reasons and attempt-session close behaviors.
- [ ] Extract one typed attempt-session runner with role-specific close strategies.
- [ ] Extract publication and merge application services onto the already-tested provider-mutation
  kernel; do not preserve known-unsafe direct provider calls.
- [ ] Replace the giant scheduler branch with a fail-closed Ready-handler registry.
- [ ] Leave `apps/server` as the composition root and service lifecycle shell.
- [ ] Add source-level ownership tests that reject orchestration policy in `apps/server`.
- [ ] Commit extraction in behavior-preserving increments.

### Task C3: Restore typed persistence and migration boundaries

**Files:**

- Create: `packages/persistence/src/schema.ts`
- Create: `packages/persistence/src/migrations/manifest.ts`
- Create: one immutable module under `packages/persistence/src/migrations/` for each existing
  migration version
- Modify: `packages/persistence/src/database.ts`
- Modify: `packages/persistence/src/migrations.test.ts`
- Modify: repository row mappers under `packages/persistence/src/`

- [ ] Replace `Record<string, unknown>` tables with exact Kysely interfaces.
- [ ] Extract existing migrations without changing their SQL or checksums.
- [ ] Add fixtures that migrate from every supported prior version.
- [ ] Compile every repository and row mapper against the typed schema.
- [ ] Prove fresh apply, incremental upgrade, checksum rejection, and repeat-open behavior.
- [ ] Commit with `refactor(persistence): type schemas and isolate migrations`.

## Phase D: Close safety-critical Core gaps

### Task D1: Exclusive writer and startup recovery

**Files:**

- Create: `packages/adapters/src/service-lock.ts`
- Create: `packages/adapters/src/service-lock.test.ts`
- Create: platform-specific lock implementations under `packages/adapters/src/`
- Create: `packages/persistence/src/service-fence-store.ts`
- Create: `packages/persistence/src/service-fence-store.test.ts`
- Modify: `packages/persistence/src/schema.ts` after Task C3, or the current database schema boundary
  when D1 precedes C3
- Create: an immutable fencing migration under the active migration boundary
- Modify: migration fresh-apply and every-supported-upgrade tests
- Create: `packages/orchestration/src/startup/coordinator.ts`
- Create: `packages/orchestration/src/startup/coordinator.test.ts`
- Modify: `apps/server/src/service-runtime.ts`
- Modify: `apps/server/src/startup-recovery.ts`
- Modify: `apps/server/src/corrupt-store-recovery.ts`

- [ ] Canonicalize the database identity and acquire a non-reentrant OS lock before SQLite, WAL, or
  migration access.
- [ ] Hold the lock until workers/mutations stop and the database closes; define crash/stale-lock
  behavior for Linux, macOS, and WSL.
- [ ] Persist a fencing epoch plus `ServiceRun` identity and reject stale privileged writers.
- [ ] Prove two real processes cannot own one durable store through direct, symlink, or aliased
  paths concurrently.
- [ ] Reconcile processes, workspaces, claims, timers, questions, budgets, and every unresolved
  side-effect intent before readiness.
- [ ] Query providers by idempotency key without issuing a new mutation.
- [ ] Keep dispatch and privileged mutation disabled on incomplete recovery.
- [ ] Commit with `feat(recovery): enforce exclusive fail-closed startup`.

### Task D2: Persistence fail-closed provider mutation

**Files:**

- Create: `packages/orchestration/src/mutations/provider-mutation.ts`
- Create: `packages/orchestration/src/mutations/provider-mutation.test.ts`
- Modify: `packages/orchestration/src/scheduler/persistence-safety.ts`
- Modify all current provider mutation callers under `apps/server/src/` before extraction; Task C2
  later moves these already-safe callers without changing the mutation boundary

- [ ] Centralize authorization, intent, health recheck, adapter call, receipt, and uncertain-result
  reconciliation.
- [ ] Write failure-interleaving tests immediately before and after every external boundary.
- [ ] Stop workers and reject new mutations when accounting or durable terminal writes are unsafe.
- [ ] Prove no route, scheduler handler, or coordinator calls a mutating adapter directly.
- [ ] Commit with `feat(safety): gate privileged mutations on durable health`.

### Task D3: Configuration and authenticated control safety

**Files:**

- Create: `packages/orchestration/src/config/manager.ts`
- Create: `packages/orchestration/src/config/manager.test.ts`
- Create: `packages/orchestration/src/control-mutation.ts`
- Create: `packages/orchestration/src/control-mutation.test.ts`
- Modify: `apps/server/src/persistent-control-api.ts`
- Modify: `apps/server/src/control-api.ts`
- Modify: `apps/server/src/service-runtime.ts`
- Modify configuration persistence modules

- [ ] Reject wrong types, invalid ranges, literal secrets, malformed operators, unsupported adapter
  posture, and cross-field errors before persistence.
- [ ] Record every authenticated accepted or rejected mutation as an `OperatorAction`.
- [ ] Implement exact scoped idempotency and expected-version behavior.
- [ ] Apply hot values to the next tick, attempt values only to new work, and restart values only
  after restart.
- [ ] Implement exact-candidate acknowledgment without changing the last known good state early.
- [ ] Commit with `feat(config): enforce live validated control mutations`.

### Task D4: Agent sandbox, posture, and approval handling

**Files:**

- Modify: `packages/adapters/src/contracts.ts`
- Modify: `packages/adapters/src/codex-app-server.ts`
- Modify: `packages/adapters/src/linux-sandbox.ts`
- Create: `packages/adapters/src/macos-sandbox.ts`
- Create: `packages/adapters/src/macos-sandbox.test.ts`
- Create: `packages/adapters/src/platform-sandbox.ts`
- Create: `packages/adapters/src/platform-sandbox.test.ts`
- Modify or create platform process-ownership modules and real-process tests
- Modify: `apps/server/src/startup-configuration.ts`
- Create agent-boundary and approval tests beside these modules

- [ ] Carry resolved thread, turn, approval, and sandbox posture in launch contracts.
- [ ] Validate posture against the live Codex manifest before charging work.
- [ ] Launch Codex inside the OS-enforced workspace, HOME, credential, socket, and process boundary.
- [ ] Persist approval requests as AwaitingHuman work with scoped, expiring decision requirements;
  defer decision consumption and origin-stage resume to Task E1.
- [ ] Prove credential-file, environment, socket, path, and symlink escape attempts fail.
- [ ] Add the macOS filesystem/process/credential boundary and a fail-closed platform selector; do
  not defer missing implementation to the later macOS evidence gate.
- [ ] Commit with `feat(agent): enforce configured sandbox and approvals`.

## Phase E: Complete lifecycle conformance

### Task E1: Canonical scheduler and human reconciliation

**Files:**

- Modify the extracted scheduler modules from Task C2
- Modify: `packages/orchestration/src/scheduler/poll-tick.ts`
- Modify: `packages/orchestration/src/scheduler/running-reconciliation.ts`
- Add question, approval, reminder, and Ready-reason tests

- [ ] Use one production and test poll order.
- [ ] Reconstruct AwaitingHuman questions, approvals, reminders, and cursors.
- [ ] Implement first-authorized-answer-wins and origin-stage resume.
- [ ] Handle every lane/eligibility Ready reason or park it with a typed durable reason.
- [ ] Prove unknown reasons fail closed without stranding a claim.
- [ ] Commit with `feat(scheduler): unify durable reconciliation and dispatch`.

### Task E2: Results, reclassification, budgets, and review evidence

**Files:**

- Modify attempt result consumer and closure modules
- Modify classification and verification coordinators
- Modify budget ledger and usage modules
- Modify review and merge persistence/coordinator modules

- [ ] Reject duplicate terminal results and invalid result combinations.
- [ ] Reclassify the final diff upward before verification and acquire newly required gates.
- [ ] Implement rolling windows, atomic top-ups, fan-out, delayed overruns, resets, and resume.
- [ ] Persist current-head Guard Decisions and exact patch-identity carry-forward.
- [ ] Prove fresh review for changed patch identity and linked evidence for identical identity.
- [ ] Complete retry-after, outage, salvage, and non-implementation continuation recovery.
- [ ] Commit as separate result, budget, and review slices.

## Phase F: Complete product and operational behavior

### Task F1: Learning, notification, quality, logs, and retention

**Files:**

- Create persistence stores and orchestration services for lessons, notifications, quality metrics,
  durable logs, retention policies, holds, deletion, and tombstones
- Extend adapter contracts and concrete notification adapters
- Extend event projection and query stores

- [ ] Capture every required lesson without agent cooperation.
- [ ] Deliver idempotent notifications with intents, receipts, retries, and UI-visible failures.
- [ ] Implement sampled audits, escaped-defect demotion, repair linking, and quality projections.
- [ ] Persist scrubbed stage-grouped LogRecords before Pino/SSE projection.
- [ ] Preserve indefinite history by default and protected aggregates/tombstones after deletion.
- [ ] Commit each durable aggregate with its API-independent tests.

### Task F2: Complete Control API

**Files:**

- Extend: `packages/contracts/src/control-api.ts`
- Extend: `apps/server/src/control-api.ts`
- Extend generated OpenAPI and client code through the repository generators
- Add paginated query and mutation handlers

- [ ] Add session read/logout/revoke and rate-limited security logging.
- [ ] Add every required state, history, budget, quality, notification, queue, log, usage, review,
  evidence, link, configuration, and audit read.
- [ ] Add question, approval, acknowledgment, budget, autonomy, queue, synthesis, retention, and
  refresh mutations through the control-mutation kernel.
- [ ] Wire authenticated, versioned, idempotent synthesis requests into scheduler triggering and
  prove repeated requests create at most one active synthesis SystemJob.
- [ ] Prove authentication, authorization, CSRF, version, idempotency, structured errors, and audit
  for every route family.
- [ ] Commit by cohesive resource family.

### Task F3: Complete accessible operator UI

**Files:**

- Extend route, query, dashboard, history, and settings modules under `apps/web/src/`
- Add source-owned accessible component modules under `apps/web/src/components/`
- Extend production Playwright journeys under `tests/e2e/`

- [ ] Build complete operations, history, and settings/control surfaces from Control API data only.
- [ ] Restore sessions, support logout, retain submitted failed values, and expose stale/error state.
- [ ] After every accepted configuration create/update/clear, discard optimistic state and reconcile
  from the authoritative effective server value/version/source; never present the submitted value as
  committed before that readback.
- [ ] Keep shareable filters, tabs, pages, and time ranges in the URL.
- [ ] Add skip navigation, keyboard flows, focus-first-error, safe links, localized date formatting,
  zoom/reflow, and accessible live updates.
- [ ] Prove hostile content and CSP behavior against the built server.
- [ ] Commit by complete user journey.

## Phase G: Quality, delivery, and external proof

### Task G1: Canonical gate, coverage, and mutation testing

**Files:**

- Modify: `Makefile`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `stryker.config.mjs`
- Modify: `.github/workflows/ci.yml`
- Extend production E2E and container harnesses

- [ ] Make `make verify` own the complete non-publishing semantic gate used by CI.
- [ ] Run Playwright against built Fastify and real required API flows.
- [ ] Collect and retain complete coverage with a measured non-regression floor.
- [ ] Establish the bounded Stryker baseline and classify every survivor.
- [ ] Enforce the reviewed baseline floor, ratchet toward 80 percent, target 90 percent for pure
  authorization/transitions, and reject every critical surviving mutant.
- [ ] Prove Linux, macOS, WSL, non-root/read-only container, restart, persistence, signal, and real
  runtime dependency behavior.
- [ ] Choose and implement one executable distribution boundary for `gh`, Codex, and Bubblewrap:
  pinned image content or documented external injection. Fail readiness/dispatch when a required
  runtime dependency is unavailable, and prove the choice in the non-root read-only image.
- [ ] Commit with `test(quality): enforce behavioral regression gates`.

### Task G2: Repository governance and immutable delivery

**External state:**

- GitHub repository rulesets, tag rulesets, merge settings, Dependabot security settings, Actions,
  GHCR, attestations, and releases

- [ ] Protect `main` with PR, stable required checks, current-head or merge-queue validation,
  resolved conversations, and the permitted approval rule.
- [ ] Disable force pushes and non-squash merge methods required by policy.
- [ ] Protect stable semantic tags from movement.
- [ ] Enable prompt Dependabot security updates and keep major/compatibility-sensitive updates
  reviewable.
- [ ] Pass PR, merge-group, and protected-main canonical workflows at exact revisions.
- [ ] Publish one immutable image and Node distribution with SBOMs, checksums, provenance, and
  successful security scans.
- [ ] Promote the same digest through one semantic release without rebuilding.
- [ ] Verify the documented rollback selects a prior verified digest.

### Task G3: Core and Real Integration completion

**Files:**

- Complete deterministic evidence for all 35 Core IDs
- Create a redacted Real Integration report artifact
- Update: `IMPLEMENTATION_STATUS.md`
- Update the PR title/body and review packets

- [ ] Pass every fixed Core case with exact-revision evidence.
- [ ] Run the full real GitHub/Codex/auth/UI/hooks/merge/restart/question/ack/budget/replay/repair
  profile in a non-production repository.
- [ ] Report selected adapters as implemented rather than partial or contract-only.
- [ ] Produce `core_conformance: true` and `production_ready: true` without manual checkbox editing.
- [ ] Run fresh adversarial architecture, Core, product, security, and delivery review waves.
- [ ] Resolve every critical/high finding and justify or resolve medium findings.
- [ ] Decide whether PR `#3` remains one greenfield review or becomes a non-destructive stacked PR
  series; preserve exact evidence for each mergeable unit.
- [ ] Push a clean exact head, make the final PR ready for review, and verify all required checks.

## Program exit

- [ ] Every traceability entry is implemented or has an accepted `SHOULD` justification.
- [ ] Every Core ID and the Real Integration Profile pass at the final revision.
- [ ] Local, platform, container, remote CI, mutation, publication, promotion, and rollback evidence
  is current.
- [ ] `IMPLEMENTATION_STATUS.md`, conformance reports, and the PR describe only verified facts.
- [ ] The final worktree is clean, intended commits are pushed, and the ready PR is green.
