# Conformance UI and Control-Plane Hardening Design

## Purpose

Revise `SPEC.md` as an implementable conformance specification. Preserve the compact v3 architecture
while closing its state, authority, cost, review, configuration, and operator-interface gaps. Make a
visual operator UI and its authenticated control API required for core conformance.

## Configuration Sources

`WORKFLOW.md` remains the repository-owned, versioned baseline. Its YAML front matter supplies
configuration; its Markdown body supplies the prompt and synthesized rules.

Effective configuration resolves in this order:

1. Built-in defaults.
2. `WORKFLOW.md` front matter.
3. Durable operator overrides created through the authenticated control API or UI.

The UI shows each effective value, its source, and any pending restart or acknowledgment. Clearing
an override returns control to the file. Every override, acknowledgment, reset, and deletion is
authenticated, audited, and included in subsequent immutable configuration snapshots.

Executable or authority-changing values require explicit operator acknowledgment before they take
effect. This includes hooks, agent commands, verification commands, notification commands,
environment access, approval and sandbox posture, operator membership, and equivalent adapter
settings.

## Required UI and Control API

Core conformance requires both an authenticated visual UI and the control API that backs it. An API
without the UI does not conform.

The UI has three required surfaces:

1. An operations dashboard showing current issues by lane, running attempts, retries, parked work,
   the merge queue, budgets, spend, and direct links to tracked issues and generated pull requests.
2. An issue and run view showing the stage timeline, time in each stage, attempts and roles, agent
   events and logs, verification results, review findings, tokens, cost, elapsed time, outcomes,
   evidence, configuration snapshot, and issue and pull-request links.
3. A settings and controls view showing effective values and sources, durable overrides, privileged
   change acknowledgments, budget changes and resets, autonomy controls, merge-queue controls,
   synthesis triggers, and the operator audit trail.

The UI reads the same durable control-plane records used by orchestration. It does not reconstruct
state from tracker comments, process memory, or humanized log text.

## Durable History

The durable store retains attempts, live-session identity, retry timers, Human-lane origin and
reason, questions and answers, stage transitions, side-effect intents and receipts, configuration
snapshots, review records, budgets, tokens, costs, elapsed time, structured events, logs, operator
actions, and issue and pull-request links.

The default retention policy is indefinite. Completed issues and previous service runs remain
browseable after completion and restart. Finite retention or deletion requires explicit operator
policy or action, is audited, and must preserve records still referenced by active work or required
for cost and quality totals.

## Execution and Authority Boundaries

Agents may edit files only inside their assigned workspace. They return typed terminal results and
typed requests for privileged or external side effects. The orchestrator performs tracker,
repository-hosting, pull-request, and merge mutations through typed adapters.

Every external mutation is authorized against the attempt role, pinned configuration, current
tracker state, and target revision. The orchestrator commits an idempotent intent before executing
the mutation and records a receipt afterward. Restart recovery reconciles intents without receipts.

The durable model includes explicit live-session, retry, parked-work, operator-question,
side-effect, and stage-transition records. Non-running reservations do not expire merely because no
agent process is renewing a lease.

## Plans and Change Classes

Plans use a typed format that records acceptance-criterion mappings, proposed paths, verification
commands, and estimated size. Classification occurs in two steps:

1. A conservative provisional class derived from issue and repository metadata.
2. An authoritative class derived from the validated plan, then updated from the observed diff.

Classification may move upward but not downward during an execution cycle. Upward reclassification
applies every newly required plan, review, compute, and merge gate before work continues.

## Cost Enforcement

Adapters that can price usage enforce per-attempt, per-issue, and rolling fleet USD budgets. Adapters
that cannot price usage enforce token equivalents at all three scopes. Dispatch reserves estimated
cost before starting attempts or review fan-out. The spec distinguishes reservation and dispatch
ceilings from hard per-attempt termination.

If the runner terminates an attempt at a hard cap, the orchestrator records a
`budget_exhausted` result and preserves the latest durable handoff. It does not claim that the
terminated agent produced the result. Cost and token accounting remain deduplicated across replayed
adapter events.

## Review, Git, and Merge

Each attempt role has an explicit terminal-result schema. Review attempts atomically produce review
records; they do not misuse implementation outcomes. Outcome salvage uses the attempt's pinned
profile or a separate attempt and never changes model inside a thread.

A typed repository-hosting adapter owns branch publication, pull-request creation and updates,
required-check discovery, review and thread snapshots, rebases or updates, merges, and post-merge
status. Pull-request snapshots include head and base revisions. The spec defines required checks,
accepted conclusions, unresolved-thread policy, stale-review rejection, and identical-diff
comparison.

Post-merge failures produce a repair branch and pull request, record an escaped defect when
appropriate, and do not leave the global queue blocked indefinitely. Sampled post-merge audits run
against a reproducible checkout of the merged revision and produce durable findings.

## Restored Conformance Boundaries

The revision restores compact forms of these v2 contracts:

- tracker eligibility filters, including required labels and optional assignee routing;
- named-priority normalization;
- approval, sandbox, startup/read-timeout, and required-skill preflight configuration;
- readiness checks and accepted check conclusions;
- tracker pagination, normalization, and typed errors;
- startup recovery, transactional dispatch, and worker-exit reconciliation algorithms; and
- Core Conformance, Extension Conformance, and Real Integration validation profiles.

The revision does not restore workpad parsing, broad raw GraphQL tools, nine workflow lanes,
per-state concurrency, the SSH appendix, provider protocol restatements, or verbose HTTP examples.
Tracker comments remain human-readable projections only.

## Conformance Validation

The test matrix covers durable history and restart recovery, UI visibility, stage timing, indefinite
default retention, settings precedence, override clearing, operator authorization, privileged
acknowledgment, budget reservation and enforcement, token-only budgets, typed side effects,
idempotent recovery, staged classification, role-specific results, review revision pinning, repair
pull requests, and external integration smoke tests.
