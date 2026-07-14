# Evidence and CI Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement
> this plan task-by-task. Use superpowers:test-driven-development for every behavior change.

**Goal:** Replace prose-derived conformance claims with exact-revision executable evidence and make
the canonical local and GitHub clean-runner gates reproducible before broader runtime refactoring.

**Architecture:** Keep normative traceability as reviewed documentation, but make a typed Core
manifest and machine-readable evidence reports the only inputs to conformance decisions. Align local
and hosted verification around repository-owned Corepack invocation, validate workflow contracts in
repository-policy tests, and make the container smoke test enter through a package-owned production
boundary.

**Tech Stack:** TypeScript, TypeBox, Vitest, Biome, Make, Corepack/pnpm, GitHub Actions, actionlint,
ShellCheck, Docker, SQLite.

---

## Preconditions and ownership

- Normative source: `SPEC.md`, `TECH_STACK.md`, and `CICD.md`.
- Audited baseline: `090cd6b818097e72524d462ab03208625a94155e`.
- Documentation-only architecture decision: `1302c0b`.
- Main-agent ownership: integration, `IMPLEMENTATION_STATUS.md`, commits, push, PR title, and remote
  verification.
- Delegated work may own only the files named by its task; sub-agents do not commit or push.
- Complete Task 1 before changing conformance code. Complete Tasks 2-4 before claiming a repaired
  CI baseline.

## Task 1: Audit and commit normative traceability

**Files:**

- Verify: `docs/compliance/README.md`
- Create and verify: `docs/compliance/spec-traceability.md`
- Create and verify: `docs/compliance/tech-stack-traceability.md`
- Create and verify: `docs/compliance/cicd-traceability.md`
- Modify: `IMPLEMENTATION_STATUS.md`

- [x] Compare every explicit and inherited `MUST`, `MUST NOT`, and `SHOULD` in each top-level
  document with one stable, source-ordered matrix row.
- [x] Inventory every unkeyworded schema, enum, transition, configuration table, required surface,
  adapter operation, normalized event/error mapping, and reference-algorithm invariant that the
  source declares normative.
- [x] Check that each row contains source, strength, status, implementation, evidence, remaining
  work, dependency, and workstream fields.
- [x] Spot-check every inherited normative list and all Core, Real Integration, CI, release, and
  repository-governance sections against the source text.
- [x] Reject `implemented` status where the evidence is only a unit fake, an authored workflow, a
  schema, or an implementation-status claim.
- [x] Reconcile the matrices with the four architectural reviews and the selected design.
- [x] Correct stale `IMPLEMENTATION_STATUS.md` claims, including the audited revision, 581-test
  baseline, current synthesis position, adapter status, CI failure, and external-setting gaps.
- [x] Run `corepack pnpm exec markdownlint-cli2 docs/compliance/*.md IMPLEMENTATION_STATUS.md
  docs/superpowers/plans/*.md docs/superpowers/specs/*.md`.
- [x] Run `git diff --check`.
- [ ] Commit with `docs(compliance): establish normative traceability`.

## Task 2: Define an exact Core evidence contract

**Files:**

- Create: `packages/contracts/src/conformance.ts`
- Create: `packages/contracts/src/conformance.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json` only if its exports require an explicit entry
- Modify: `scripts/generate-contract-schemas.ts`
- Regenerate: `packages/contracts/generated/contracts.schema.json`

### Step 1: Write the failing contract tests

- [x] Add a compile-time and runtime assertion for the exact 35 Core IDs from `SPEC.md` Section
  19.2, with no omissions or extras.
- [x] Bind each Core entry to its section/bullet ordinal, normalized requirement-text hash, required
  adapters, and required platforms; fail when Section 19.2 count, order, or text drifts.
- [x] Add schema tests for one evidence result per ID containing the evidence command/test,
  revision, status, producer version, exit code, environment/platform, artifact digest, and optional
  external artifact reference.
- [x] Reject unknown IDs, duplicate IDs, missing IDs, failed/skipped/partial results, empty evidence,
  and results from a different revision.
- [x] Represent adapter and Real Integration evidence separately so neither can be inferred from
  Core unit evidence.
- [x] Represent Section 1-18 normative-requirement evidence separately from the 35 Section 19.2
  Core test results; neither set can substitute for the other.
- [x] Run `corepack pnpm --filter @symphony/contracts test -- conformance.test.ts` and confirm the new
  tests fail for the missing implementation.

### Step 2: Implement the smallest typed manifest

- [x] Add readonly ID tuples, derived unions, TypeBox schemas, and validation helpers without
  importing persistence, server, or script modules.
- [x] Keep hashing, filesystem, Git, and command execution outside the contracts package; store
  reviewed manifest hashes as literals and recompute them in tests/scripts.
- [x] Export the contract from the package barrel.
- [x] Rerun the focused test and `corepack pnpm --filter @symphony/contracts typecheck`.
- [x] Review for a single source of truth: no second handwritten Core ID list is permitted.

## Task 2A: Produce trusted evidence from canonical execution

**Files:**

- Create: `scripts/conformance-evidence.ts`
- Create: `scripts/conformance-evidence.test.ts`
- Modify: `Makefile`

- [ ] Write failing tests proving a manually authored passing JSON document, a stale artifact, a
  mismatched command/test selector, or a forged producer version cannot satisfy a Core ID.
- [ ] Reject a dirty tracked worktree as revision-bound evidence.
- [ ] Map each Core ID to exact canonical test selectors and required adapter/platform dimensions.
- [ ] Run the command through the repository runner and record command, exit code, revision,
  producer/schema version, environment/platform, and output artifact digest only after completion.
- [ ] Emit evidence atomically and fail closed when a selector is absent, skipped, filtered out, or
  does not execute.
- [ ] Make `make conformance` create a private temporary evidence directory, invoke the producer,
  and pass that same-invocation output directly to the reporter; do not accept a caller-supplied
  local passing document. Hosted evidence must use the CI platform's signed attestation bound to the
  workflow and source revision.
- [ ] Keep trusted local results opaque and mark only objects returned by the in-process producer;
  do not export any API that can seal arbitrary caller JSON.
- [ ] Derive report time from immutable evidence or `SOURCE_DATE_EPOCH`; do not put wall-clock time
  into the deterministic payload.
- [ ] Run `corepack pnpm vitest run scripts/conformance-evidence.test.ts` through red and green
  phases.

## Task 3: Make the conformance reporter fail closed and idempotent

**Files:**

- Modify: `scripts/conformance-report.ts`
- Modify: `scripts/conformance-report.test.ts`
- Modify: `Makefile`
- Modify: `.gitignore` only if the evidence/output boundary is currently ambiguous

### Step 1: Reproduce false-positive and output-drift defects

- [ ] Replace the existing one-checkbox success test with failing cases for missing, duplicate,
  unknown, failed, skipped, stale-revision, and evidence-free Core rows.
- [ ] Add failing cases showing `production_ready` remains false when Core passes but any adapter is
  partial/contract-only, Real Integration is absent/failed, or required external release evidence is
  absent.
- [ ] Add a test that writes the report, runs the repository formatter/checker against it, reruns
  conformance, and proves byte-stable output.
- [ ] Run `corepack pnpm vitest run scripts/conformance-report.test.ts` and capture the intended
  failures.

### Step 2: Replace ledger parsing with evidence aggregation

- [ ] Read only typed machine evidence and the exact manifest from Task 2.
- [ ] Calculate `core_conformance` only when every Core ID has passed evidence at the requested
  revision.
- [ ] Also require complete passing machine evidence for every Section 1-18 normative matrix row and
  passing selected tracker, repository-host, agent, and authentication adapters. Until that mapping
  exists, emit a missing `normative_coverage` gate and keep Core false even if all 35 tests pass.
- [ ] Calculate `production_ready` only when Core, adapter, Real Integration, container/platform,
  delivery, security, artifact, promotion, rollback, and repository-governance evidence all pass at
  the exact revision.
- [ ] For mutable external evidence, require repository identity, branch/tag target, observed state
  revision/hash, environment, observation time, expiry policy, and live revalidation at the final
  checkpoint.
- [ ] Report incomplete categories and evidence paths without converting absence into success.
- [ ] Use fixed Real Integration case IDs and fixed external requirement IDs for Linux/macOS/WSL,
  container, CodeQL, dependency review, Gitleaks, Trivy, workflow security, branch/squash/check/queue
  policy, image/SBOM/provenance, promotion-without-rebuild, and rollback.
- [ ] Write formatted deterministic JSON atomically, preserving a useful incomplete report when the
  command exits nonzero.
- [ ] Run the TypeScript reporter with the repository source loader and development export condition;
  do not depend on prebuilt `dist` output.
- [ ] Remove `IMPLEMENTATION_STATUS.md` parsing and hardcoded adapter success assumptions.

### Step 3: Verify incomplete behavior

- [ ] Run the focused test and confirm all new cases pass.
- [ ] Run `make conformance`; expect nonzero while verifying the report states both booleans false.
- [ ] Run the formatter/lint gate twice after the failed conformance command and confirm neither
  run observes or creates a diff.
- [ ] Run `git diff --check`.
- [ ] Commit Tasks 2-3 with `feat(conformance): bind reports to executable evidence`.

## Task 4: Reproduce and repair clean-runner package-manager setup

**Files:**

- Modify: `Makefile`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/repository-policy.ts`
- Modify: `scripts/repository-policy.test.ts`

### Step 1: Add repository-policy regressions first

- [x] Add a fixture/test that executes the canonical verification entry in an environment where no
  global `pnpm` shim is on `PATH` but Node/Corepack are available.
- [x] Add workflow-policy assertions for pinned Node, pinned package manager, frozen lockfile,
  explicit shell-safe quoting, and the canonical verification target.
- [x] Add actionlint regression fixtures for the current SC2016, SC2035, and SC2251 sites.
- [x] Run `corepack pnpm vitest run scripts/repository-policy.test.ts` and confirm the new cases
  expose the current behavior.

### Step 2: Establish one repository-owned invocation

- [x] Make setup activate the `packageManager`-pinned pnpm through Corepack.
- [x] Ensure package scripts and Make targets do not recursively rely on an unprovisioned bare
  `pnpm` binary.
- [x] Make Linux, macOS, and release workflows enter through the same setup and verification graph.
- [x] Fix the three shell findings by changing quoting/globbing/control flow, not by suppressing
  ShellCheck.
- [x] Run the focused policy tests and actionlint locally.

## Task 5: Repair the production-owned container smoke boundary

**Files:**

- Modify: `scripts/verify-container.sh`
- Modify: `apps/server/package.json` if a smoke entry point is needed
- Create: `apps/server/src/container-smoke.ts` only if no existing production entry point can own
  native dependency loading
- Create: `apps/server/src/container-smoke.test.ts` only when a new entry point is introduced
- Modify: `Dockerfile` only when the package-owned boundary exposes a real image-content gap

### Step 1: Prove the current ownership defect

- [x] Add a test or isolated invocation showing deployment-root `require('better-sqlite3')` fails
  while the server package owns the dependency.
- [x] Confirm the smoke requirement: start as non-root, use a read-only root filesystem, write only
  approved volumes, persist SQLite across restart, answer health/readiness, and terminate cleanly.

### Step 2: Move smoke behavior behind its owner

- [x] Invoke the native module through a server-package production boundary rather than relying on
  root dependency hoisting.
- [x] Preserve the non-root/read-only/persistence/restart/shutdown assertions.
- [x] Do not claim dispatch-capable conformance in this task; Codex/GitHub/bubblewrap image content
  belongs to W4/W10 and must receive its own behavioral proof.
- [x] Run the focused local entry point. If Docker is unavailable locally, record that as an
  external execution gap and use remote image CI for proof after push.

## Task 6: Align canonical local gates

**Files:**

- Modify: `Makefile`
- Modify: `CICD.md` only if an actual specification defect is discovered; do not weaken a gate
- Modify: `scripts/repository-policy.test.ts`

- [ ] Make `verify-fast` the deterministic short gate and make `verify` include every locally
  applicable required test/build/drift/policy/security/container check in documented order.
- [ ] Ensure CI calls repository targets rather than maintaining a divergent command graph.
- [ ] Ensure `conformance` consumes evidence created by the applicable gates and never fabricates
  evidence from their configured existence.
- [ ] Run `make verify-fast` and `make build`.
- [ ] Run all locally applicable focused security/workflow/container checks.
- [ ] Run `make verify`; classify only genuinely unavailable provider/platform steps as external
  evidence, never as local success.
- [ ] Commit Tasks 4-6 with `fix(ci): restore clean-runner verification`.

## Task 7: Publish and verify the exact baseline revision

**External state:**

- PR `#3`
- GitHub Actions at the pushed head SHA

- [ ] Confirm the working tree contains only the intended committed checkpoint.
- [ ] Change the PR title to a Conventional Commit title that describes the umbrella scope.
- [ ] Push the current branch without rewriting published history.
- [ ] Record the exact remote head SHA and verify it equals local `HEAD`.
- [ ] Verify Linux, macOS, workflow security, dependency review, CodeQL, Gitleaks, Trivy, image,
  release-policy, and aggregate required checks at that exact SHA.
- [ ] If a job fails, diagnose from the exact current logs, add a failing reproduction where
  practical, repair narrowly, commit, push, and repeat.
- [ ] Do not mark W0 or B1 complete until every check in this checkpoint is green or a genuine
  external blocker has been demonstrated.
- [ ] Update the matrices and `IMPLEMENTATION_STATUS.md` with exact SHA-linked evidence.

## Checkpoint exit criteria

- [ ] All traceability rows have passed main-agent source and evidence review.
- [ ] No conformance success can be produced from ledger prose, missing evidence, partial adapters,
  a stale revision, or an absent Real Integration report.
- [ ] An incomplete `make conformance` is deterministic, formatted, truthful, and nonzero.
- [ ] Clean Linux and macOS runners use the pinned package manager successfully.
- [ ] actionlint and repository-policy checks pass without suppressing the identified defects.
- [ ] Container smoke passes remotely at the same head SHA through an owned production boundary.
- [ ] The PR title is conventional and all baseline-required remote checks are green.
- [ ] The working tree is clean and all checkpoint commits are pushed.
