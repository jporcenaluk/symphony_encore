# Conformance Specification Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `SPEC.md` an internally consistent conformance specification with a required operator UI, durable history, editable runtime controls, and complete state, authority, cost, review, and recovery contracts.

**Architecture:** Keep the compact v3 structure and add detail at existing boundaries. The orchestrator remains the sole durable control-plane writer; agents edit workspaces and request privileged external mutations through typed adapters. `WORKFLOW.md` remains the repository baseline, while authenticated durable UI overrides form the highest-precedence configuration layer.

**Tech Stack:** Markdown, YAML front matter, SQLite durable-state contract, authenticated HTTP control API, browser UI, tracker and repository-hosting adapters.

---

### Task 1: Complete the normative domain and authority model

**Files:**
- Modify: `SPEC.md`, Sections 2, 3, 13, 15, 16, and 17

- [x] **Step 1: Narrow the side-effect ownership statement**

Replace the claim that the orchestrator owns every side effect with a precise rule: agents may edit only their assigned workspace; the orchestrator owns every tracker, repository-hosting, control-plane, notification, and other privileged external mutation.

- [x] **Step 2: Add durable control-plane entities**

Add normative records for `LiveSession`, `RetryEntry`, `ParkedWork`, `OperatorQuestion`, `StageTransition`, `SideEffectIntent`, `SideEffectReceipt`, `OperatorAction`, and repository links. Include identifiers, timestamps, ownership, reason, target revision, status, and recovery fields needed after restart.

- [x] **Step 3: Correct claim and lease semantics**

Specify that running leases expire unless renewed, while retrying and Human-parked reservations remain durable until their explicit release condition. Persist origin lane, retry due time, blocker predicate, answer cursor, and reservation mode.

- [x] **Step 4: Define typed external-mutation flow**

Restore `actions_requested` on applicable agent results. Require role authorization, pinned configuration, current state, immutable target revision, idempotency intent before execution, and receipt after execution. Specify reconciliation of intents without receipts.

- [x] **Step 5: Add repository-hosting adapter operations**

Define typed operations for branch publication, pull-request create/update, check and review snapshots, branch update/rebase, merge, post-merge status, and repair pull requests. State that agents receive no repository-hosting or tracker credentials.

### Task 2: Make plans, classification, results, and cost enforceable

**Files:**
- Modify: `SPEC.md`, Sections 3, 4, 5, 7, 8, 9, and Appendix B

- [x] **Step 1: Add a typed Plan record**

Specify fields for revision, acceptance-criterion mappings, proposed paths, verification commands, estimated files and lines, risks, and status. Make `PLAN.md` a human-readable projection of the durable Plan record rather than a free-form decision input.

- [x] **Step 2: Define staged classification**

Use a conservative provisional class from issue and repository metadata, then an authoritative class from the validated plan and observed diff. Require upward-only movement during an execution cycle and application of newly required gates before work continues.

- [x] **Step 3: Separate terminal result schemas by role**

Keep implementation outcomes for implementation attempts. Define `PlanReviewResult`, `ReviewResult`, and `SynthesisResult`; specify atomic creation of terminal result plus durable review or synthesis records. Remove any implication that review decisions are implementation outcome statuses.

- [x] **Step 4: Fix outcome salvage**

Require a salvage turn to use the pinned model/profile in the same thread, or start a separately charged attempt. Never switch models inside an attempt or thread.

- [x] **Step 5: Define hard and dispatch budget semantics**

Add `budget.per_attempt_usd` for priced adapters and `budget.per_issue_tokens` plus `budget.rolling_24h_tokens` for unpriced adapters. Define estimated reservation before dispatch, reservation release, dispatch ceilings, hard per-attempt token/USD termination, allowed overshoot, and fleet behavior for already-running attempts.

- [x] **Step 6: Define orchestrator-authored budget termination**

When a hard cap kills an agent, record an orchestrator-authored `budget_exhausted` terminal result using the latest durable handoff; do not attribute that result to the agent.

- [x] **Step 7: Resolve compute configuration ownership**

Make adapters own provider model and effort mappings. Let `WORKFLOW.md` name logical profiles and role/class defaults without embedding provider model slugs.

### Task 3: Harden review, merge, audit, and learning behavior

**Files:**
- Modify: `SPEC.md`, Sections 9, 10, 12, 14, and 16

- [x] **Step 1: Complete the pull-request snapshot**

Include head SHA, base ref, observed base SHA, checks with target SHA, review decision, reviews, unresolved non-outdated threads, mergeability, and required-check source.

- [x] **Step 2: Define required-check and thread policy**

Specify configured checks versus repository-protection discovery, accepted conclusions, pending and missing behavior, unresolved-thread blocking, stale review rejection, and authorized operator approval.

- [x] **Step 3: Define identical-diff carry-forward**

Use a normalized tree diff or patch identity against the reviewed base and head. Require fresh CI after a base update; carry only Symphony's internal review approval when the normalized diff is identical.

- [x] **Step 4: Define repair behavior**

After a merged change fails post-merge or deployment checks, create a repair branch and pull request, record the failure as evidence and an escaped defect when applicable, and pause only the affected repository queue entry rather than blocking unrelated repositories indefinitely.

- [x] **Step 5: Define post-merge audits and synthesis jobs**

Run audits against a reproducible checkout of the merged revision. Model fleet-level synthesis as a durable `SystemJob` rather than an issue-bound Attempt, while sending its pull request through the same review and supervised merge gates.

- [x] **Step 6: Correct event common fields**

Make issue, attempt, class, profile, and cost fields nullable when the event is fleet-level. Define event-specific required fields for issue, budget, autonomy, configuration, merge, and synthesis events.

### Task 4: Make the UI and control API core conformance

**Files:**
- Modify: `SPEC.md`, Sections 2, 3, 11, 14, 15, 18, and 19

- [x] **Step 1: Replace the optional HTTP surface**

Define an authenticated control API and visual UI as REQUIRED Core Conformance components. An API without the visual UI is non-conforming.

- [x] **Step 2: Define the operations dashboard**

Require current lane counts, active attempts, retries, parked work, merge queue, budget status, spend, token totals, elapsed time, and direct links to tracked issues and generated pull requests.

- [x] **Step 3: Define issue and run history**

Require a stage timeline with time per stage; every attempt, role, event, log, command, verification result, finding, outcome, evidence item, token count, cost, elapsed time, and configuration snapshot; and browseable previous service runs after completion and restart.

- [x] **Step 4: Define settings and operator controls**

Require effective value and source display, durable override create/update/clear, budget changes and resets, privileged acknowledgments, autonomy changes, merge-queue controls, synthesis triggers, retention controls, and a durable operator audit trail.

- [x] **Step 5: Define API authorization and concurrency**

Require authenticated operators, role or capability checks, CSRF protection for browser mutations, optimistic concurrency or expected-version checks, idempotency keys, and structured error responses. All UI mutations use this API.

- [x] **Step 6: Define indefinite default retention**

Persist run summaries, stage transitions, attempts, logs, events, tokens, costs, evidence, outcomes, links, and operator actions indefinitely by default. Finite retention or deletion requires explicit audited operator policy and cannot remove records referenced by active work or durable totals.

### Task 5: Complete configuration precedence and safety

**Files:**
- Modify: `SPEC.md`, Sections 15 and 18

- [x] **Step 1: Define three-layer precedence**

Set effective order to built-in defaults, then `WORKFLOW.md`, then durable operator overrides. Show source, effective value, override revision, acknowledgment state, and restart state in the UI and configuration snapshots.

- [x] **Step 2: Define override lifecycle**

Require authenticated create/update/clear operations, expected-version checks, audit records, validation before activation, last-known-good fallback, and deterministic application by reload category.

- [x] **Step 3: Expand privileged acknowledgment**

Apply acknowledgment to hooks, agent command, verification command, notification command, environment allowlist, approval and sandbox posture, operator list, credential or authority scope, and equivalent adapter settings.

- [x] **Step 4: Restore dispatch and adapter configuration**

Add `tracker.priority_order`, `tracker.assignee`, `tracker.required_labels`, `agent.read_timeout_ms`, `agent.required_skills`, approval and sandbox pass-through fields, required checks, accepted conclusions, and review-settling timeout semantics.

- [x] **Step 5: Warn on unknown keys**

Preserve forward compatibility while requiring operator-visible warnings for unknown keys, with validation errors for unknown keys inside safety-critical namespaces when they resemble known fields.

### Task 6: Restore conformance profiles and verify the document

**Files:**
- Modify: `SPEC.md`, Sections 19 and the appendices

- [x] **Step 1: Define validation profiles**

Restore `Core Conformance`, `Extension Conformance`, and `Real Integration Profile`. Mark the UI, control API, durable history, SQLite store, tracker adapter, repository-hosting adapter, and agent adapter as core requirements.

- [x] **Step 2: Expand the test matrix**

Add tests for durable stage timing, previous-run browsing, indefinite retention, log visibility, issue and pull-request links, settings precedence, override clearing, operator authorization, CSRF and expected-version rejection, privileged acknowledgment, token-only budgets, reservation recovery, role-specific results, and idempotent external mutations.

- [x] **Step 3: Add compact reference algorithms**

Add language-neutral algorithms for startup recovery, transactional dispatch and reservation, worker exit with typed results and mutation intents, configuration override activation, and API mutation authorization.

- [x] **Step 4: Run structural verification**

Run:

```bash
git diff --check
rg -n '[T]BD|[T]ODO|implemen[t] later|fil[l] in|mayb[e]|should probabl[y]' SPEC.md
```

Expected: `git diff --check` exits 0; the placeholder scan returns no unresolved specification placeholders.

- [x] **Step 5: Run contradiction scans**

Run targeted searches for `optional`, `every side effect`, `never in workflow policy`, `retention`, `approval`, `sandbox`, `required checks`, `RetryQueued`, `AwaitingHuman`, and `outcome`. Inspect every match and reconcile conflicting normative language.

- [x] **Step 6: Compare the final document against the approved design**

Check every heading in `docs/superpowers/specs/2026-07-12-conformance-ui-and-control-plane-hardening-design.md` against the revised spec. Confirm each requirement has normative text and at least one conformance test.

- [x] **Step 7: Review the final diff**

Run:

```bash
git diff --stat 4030440..HEAD
git diff -- SPEC.md
```

Expected: only the approved design, plan, and `SPEC.md` changes are present; no unrelated files or generated artifacts appear.

### Task 7: Remediate independent conformance review

**Files:**
- Modify: `SPEC.md`

- [x] **Step 1: Enforce the workspace authority boundary**

Require a real filesystem write boundary, not only a workspace `cwd`, and test absolute, traversal, symlink, and cross-work escapes.

- [x] **Step 2: Close cost, mutation, and ownership gaps**

Add per-attempt USD enforcement; a shared external-mutation authorization envelope with fleet scope; work-ref claims for issues and SystemJobs; and audited, payload-bound control idempotency.

- [x] **Step 3: Make routing and review decisions total**

Make the `trivial` route reachable, type every role-result branch, define plan-review routing, and require a complete revision-pinned ReviewSet including the narrow identical-patch carry-forward invariant.

- [x] **Step 4: Harden bootstrap and configuration validation**

Permit first-admin bootstrap only on a pristine database, fail closed on operator-empty recovery state, reject safety-critical namespace/key near misses, and make SQLite explicitly Core.

- [x] **Step 5: Re-review until clean**

Run independent review after remediation and resolve all Critical and Important findings. Final reviewer result: ready to merge, with no remaining Critical or Important findings.
