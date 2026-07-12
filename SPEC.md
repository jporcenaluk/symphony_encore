# Symphony Encore Service Specification

Status: Draft v3

Purpose: Define a durable, cost-controlled service that orchestrates coding agents to complete
tracker issues with verified evidence, bounded spend, proportional process, and independent review —
and that improves itself from its own operating history.

Symphony Encore is a scheduler, durable control plane, policy enforcer, and agent runner. Agents
propose typed outcomes; the orchestrator validates them and owns every side effect. A successful run
ends at a workflow-defined handoff state, not necessarily `Done`.

The key words MUST, MUST NOT, SHOULD, and MAY are used per RFC 2119. Everything else is
implementation guidance.

## 1. Design Principles

Every requirement in this document traces to one of these. When a future change conflicts with a
principle, change the principle deliberately or reject the change.

1. **Feedback over procedure.** Agents are constrained by ground-truth verification (runnable
   tests, small diffs, early plan checks), not by ceremony. Procedure can be satisfied
   ceremonially; feedback cannot be faked.
2. **Cost is a control input, not a metric.** Budgets stop work. Spend is recorded durably per
   attempt and per issue, and remaining budget influences routing.
3. **Decisions read the durable store.** Guard and merge decisions consume orchestrator-owned
   records. Tracker comments are human-readable projections, never inputs to a decision.
4. **Proportional process.** Ceremony scales with a deterministic change class. A one-line fix and
   a schema migration do not take the same route.
5. **Catch errors at the cheapest point.** Issue readiness and plan quality are checked before
   implementation; correctness before merge; escaped defects after merge feed back into routing.
6. **Graduated autonomy.** Merge autonomy is earned per change class from measured outcomes,
   granted by the operator, and revoked automatically on an escaped defect.
7. **The system learns.** Failures, findings, and confusions are recorded as lessons and
   periodically synthesized back into the workflow prompt and rules, under hard saturation caps.
8. **Simplicity pays rent.** Every lane, field, rule, and config key must justify its existence.
   Prefer attributes to states, deletion to configuration, and one good default to three options.

## 2. System Overview

Components:

1. **Workflow Loader** — reads `WORKFLOW.md` (YAML front matter + prompt body), validates, and
   commits immutable configuration snapshots.
2. **Orchestrator** — owns the poll tick, dispatch, claims, retries, reconciliation, budgets, and
   the merge queue. Sole writer of durable control-plane state.
3. **Durable State Store** — local SQLite, single writer. Holds claims/leases, attempts (with
   cost), outcomes, guard decisions, review records, lessons, quality metrics, config snapshots,
   and side-effect intents/receipts.
4. **Workspace Manager** — per-issue directories under a configured root, lifecycle hooks, cleanup.
5. **Agent Runner** — launches the coding-agent subprocess in the workspace, streams events,
   enforces timeouts/turn caps/token caps, requires exactly one structured outcome, and terminates
   the full process tree.
6. **Review Coordinator** — runs deterministic checks, dispatches the integrative reviewer and any
   risk-triggered specialists, merges findings without voting, records durable review records.
7. **Merge Queue** — serializes merges; re-validates against the current base before each merge.
8. **Learning Synthesizer** — periodically distills lessons into proposed prompt/rule changes,
   submitted through the same review pipeline as code.
9. **Notifier** — fires the configured notification hook on events that need a human.
10. **Observability** — structured logs (required), append-only event records (required), HTTP
    status surface (optional).

External dependencies: an issue tracker (GitHub Issues + Projects v2 is the reference; adapters may
target others), a coding-agent executable speaking a supported adapter protocol (Codex app-server is
the reference), Git, and the local filesystem.

## 3. Domain Model

Only fields that decisions depend on are normative. Adapters may carry extra data.

### 3.1 Issue (normalized)

`id`, `identifier` (human key), `title`, `description`, `state` (lane), `labels` (lowercased),
`priority` (integer or null; lower dispatches first), `blocked_by` (list of `{id, state}`),
`assignee_id`, `repo_owner`, `repo_name`, `url`, `created_at`, `updated_at`.

### 3.2 Attempt

One dispatched agent run. Every attempt has exactly one **role** and one pinned compute profile.

Roles: `plan_review`, `implementation`, `integrative_review`, `specialist_review`, `adjudication`,
`synthesis`.

Fields: `id`, `issue_id`, `role`, `attempt_number`, `workspace_path`, `config_snapshot_id`,
`compute_profile`, `model`, `reasoning_effort`, `routing_reasons` (rule ids), `change_class`,
`started_at`, `ended_at`, `status`, `outcome_id`, `failure_class`,
**`input_tokens`, `output_tokens`, `cost_usd`** (estimated from the adapter's price table; updated
as events stream and finalized at exit).

Cost fields are REQUIRED on the durable record. An implementation that cannot price tokens MUST
still persist token counts and treat configured budgets as token budgets.

### 3.3 Outcome

Exactly one structured terminal outcome per attempt. Free-form prose is not a conforming result.

`status`: one of
`completed` | `plan_ready` | `needs_rework` | `blocked` | `needs_input` | `no_progress` |
`budget_exhausted` | `failed`.

Fields: `status`, `summary`, `evidence` (typed refs: commands run with results, files, commits, PR,
checks), `verification` (result of the workspace verify command — REQUIRED for `completed`
implementation attempts), `question` (REQUIRED for `needs_input`: `{text, options[], default}`),
`confusions` (short list; feeds lessons), `handoff` (facts for a fresh session: goal, acceptance
criteria, revision, files changed, commands+results, decisions fixed, open items — never hidden
reasoning or claims of correctness).

The orchestrator maps outcomes to transitions (Section 5.4); agents never mutate tracker state.

### 3.4 Claim / Lease

`issue_id`, `holder`, `expires_at`. States: `Unclaimed` → `Claimed` → `Released`.

A claimed issue is in exactly one of three claim modes:

- `Running` — an attempt is executing; consumes a concurrency slot.
- `RetryQueued` — a retry timer exists; consumes no slot.
- `AwaitingHuman` — parked pending operator input/review/unblock; consumes no slot. Reconciled
  each tick; released if the issue goes terminal.

Claims are acquired transactionally before any worker launch and renewed while running. Expired
leases enter restart reconciliation and are never blindly resumed.

### 3.5 Configuration Snapshot

Immutable record: `id`, `created_at`, `workflow_source_hash`, `effective_config` (secrets as
references, never values), `prompt_hash`, `adapter_version`. Every attempt pins exactly one
snapshot. Hot-reloadable settings (poll interval, concurrency, budgets) apply to the live
scheduler; everything else applies to attempts created after the reload. Hook and agent-command
changes additionally require operator acknowledgment (Section 15.3).

### 3.6 Review Record

Durable, orchestrator-written: `id`, `issue_id`, `attempt_id`, `reviewer_role`, `target_sha`,
`decision` (`approve` | `needs_rework` | `needs_human` | `blocked`), `findings[]`
(`{behavior, severity, evidence, disposition, blocking}`), `created_at`.

**Guards read review records and guard decisions from the store only.** A review result that exists
only in a tracker comment does not exist.

### 3.7 Guard Decision

Durable: `issue_id`, `requested_transition`, `result` (`allow` | `deny`), `reason_code`, `evidence
refs`, `created_at`. Denials route per Section 5.4 and emit a lesson when caused by agent output.

### 3.8 Lesson

Append-only: `id`, `created_at`, `issue_id`, `source`
(`guard_denial` | `rework` | `review_finding` | `escaped_defect` | `plan_rejection` |
`tool_failure` | `budget_exhausted` | `confusion`), `text`, `evidence refs`. Input to synthesis
(Section 12).

### 3.9 Rule

A numbered, synthesized instruction in the workflow prompt's rules block: `id`, `text`,
`lesson_ids`, `citation_count`, `last_cited_at`. Subject to the saturation caps in Section 12.3.

## 4. Change Classes and Proportional Process

Every issue is classified deterministically at dispatch, and reclassified upward (never downward)
if evidence changes (diff grows, risky paths touched).

- `trivial` — matches configured allow-patterns (docs, comments, config values, single-file changes
  under `class.trivial_max_changed_lines`, default 25) and touches no risk paths.
- `standard` — the default.
- `high_risk` — matches any risk rule: security boundaries, auth, migrations, concurrency,
  public API changes, cross-package architecture, configured sensitive paths, or ambiguous
  acceptance criteria.

Classification inputs MUST be observable facts (paths, labels, diff size, dependency graph,
issue text patterns) — never agent self-assessment.

What each class buys:

| | trivial | standard | high_risk |
|---|---|---|---|
| Plan gate | none | deterministic, in-session | model plan review (economy) |
| Review | deterministic checks only + sampled audit | integrative review | integrative + triggered specialists |
| Merge autonomy eligible | yes | yes, once earned | never auto-merges |
| Default compute | economy | standard | deep floor where triggered |

Sampled audits: `quality.audit_rate` (default 0.10) of merged `trivial`/`standard` issues receive a
post-merge deep review whose findings become lessons and count as escaped defects when blocking.
This is the calibration check on the cheap routes.

## 5. Issue Lifecycle

### 5.1 Lanes

Six lanes. Rework, blockage, and questions are *attributes* (a reason recorded durably and
projected as a label), not lanes.

- `Backlog` — not dispatchable; never touched by Symphony.
- `Todo` — dispatchable when unblocked (`blocked_by` all terminal).
- `In Progress` — implementation attempts run here, including rework cycles.
- `Review` — protected. Review attempts and the merge queue operate here.
- `Human` — parked for the operator, with a durable `reason`: `needs_input`, `human_review`,
  `blocked`, `budget_exhausted`, `no_progress`. Consumes no agent slot.
- `Done` — terminal. Other terminal tracker states (`Closed`, `Cancelled`, `Duplicate`) are
  treated as `Done`.

Valid transitions: `Todo → In Progress → Review → Done`; `Review → In Progress` (rework);
any non-terminal lane `→ Human` and `Human →` back to its origin lane once resolved. Direct
`In Progress → Done` is invalid.

### 5.2 Poll Tick

Every `polling.interval_ms` (default 30000):

1. Reconcile running attempts (stall detection; tracker state refresh — terminal state stops the
   worker and cleans the workspace; a lane change away from the attempt's lane stops the worker
   without cleanup).
2. Reconcile `AwaitingHuman` claims (operator answered? unblocked? terminal?).
3. Advance the merge queue (Section 10.3).
4. Validate config; on failure skip dispatch this tick but keep reconciling.
5. Fetch candidates, sort (priority, then oldest `created_at`, then identifier), dispatch while
   global slots (`agent.max_concurrent`, default 4) and budgets allow.
6. Check learning trigger (Section 12.2) and daily budget (Section 7.1).

Tracker adapters SHOULD support a webhook or event-stream trigger for an immediate tick;
polling is the required baseline.

### 5.3 Implementation Attempt Flow

1. Classify change class; select compute route; commit config snapshot; transactionally acquire
   lease + create attempt; move issue to `In Progress`.
2. Prepare workspace (Section 6); run `before_run` hook.
3. **Plan first.** The rendered prompt requires the agent to write `PLAN.md` in the workspace
   (approach, files to touch, acceptance-criteria mapping, verification commands, estimated size)
   before changing code.
   - `trivial`: no gate; proceed.
   - `standard`: the orchestrator validates the plan deterministically in-session (file exists;
     every acceptance criterion mapped; touched-path scope consistent with the issue and class;
     size estimate within class bounds). Failure → one in-session revision message with the
     specific objection; second failure → `needs_input` with the objection as the question.
   - `high_risk`: the session ends with outcome `plan_ready`. A `plan_review` attempt
     (economy profile, fresh context, reads issue + `PLAN.md` + repo — never builder narrative)
     returns `approve` / `needs_rework` (one revision cycle) / `needs_input`. On approval an
     implementation attempt resumes in the same workspace with the approved plan as handoff.
   - If the issue itself is not implementable as specified (missing acceptance criteria,
     contradictory requirements), the correct plan-stage outcome is `needs_input` — the plan gate
     doubles as the issue-readiness check.
4. Implement in short sessions: `agent.max_turns` default 8, `agent.turn_timeout_ms` default
   900000 (15 min), token cap per Section 7. State lives in the workspace and the durable store,
   not in long threads. Continuation guidance is orchestrator-rendered and MUST contain: current
   plan state, last verification output, unmet acceptance criteria, remaining turn/token budget,
   and the instruction to keep `PLAN.md` current. It MUST NOT resend the original prompt.
5. **Verify before claiming done.** `completed` requires `verification` evidence from actually
   running `workspace.verify_command` (Section 6.2). The orchestrator rejects a `completed`
   outcome without it as a protocol failure.
6. Push branch, ensure PR (Section 10.1), record outcome, move to `Review`.

### 5.4 Outcome Routing

| Outcome | Orchestrator action |
|---|---|
| `completed` (implementation) | verify evidence + guards → `Review` |
| `plan_ready` | dispatch plan review |
| `needs_rework` | stay/return to `In Progress`; findings attached to next attempt; bounded by `agent.max_rework_cycles` (default 2), then `Human(human_review)` |
| `blocked` | `Human(blocked)` with the named external blocker; claim → `AwaitingHuman` |
| `needs_input` | `Human(needs_input)`; question rendered per Section 11.2 |
| `no_progress` | retry once fresh; second time → `Human(no_progress)` |
| `budget_exhausted` | `Human(budget_exhausted)` with spend summary |
| `failed` | classify (Section 13) and retry only within budget |

Missing, malformed, or evidence-free outcomes are protocol failures (`agent_process`), never
success.

## 6. Workspaces and Verification

### 6.1 Layout and Safety Invariants

- Path: `<workspace.root>/<sanitized identifier>` (`[A-Za-z0-9._-]`, others → `_`).
- The agent subprocess `cwd` MUST be the workspace path.
- The workspace path MUST resolve (symlinks included) to a descendant of `workspace.root`;
  string-prefix checks are insufficient.
- One lease owns one mutable workspace; unowned workspaces are quarantined at startup.
- The runner MUST launch the agent in a process group (or equivalent) and, on cancellation,
  timeout, stall, or shutdown, terminate all descendants and verify exit before releasing the
  lease.
- Workspaces persist across attempts for the same issue; terminal issues are cleaned at startup
  and on reconciliation.

### 6.2 Verification Loop (REQUIRED)

`workspace.verify_command` is a REQUIRED config value: the command that provides ground truth for
this repository (tests, typecheck, lint, build — repository's choice). Setting it to the literal
`none` is permitted only with `workspace.verify_none_reason` documented, and restricts all issues
to `supervised` merges.

The prompt MUST instruct agents to run it early and often; the orchestrator enforces it at the
`completed` boundary (Section 5.3 step 5) and the merge queue re-runs required CI checks
regardless.

### 6.3 Hooks

`after_create` (fatal on failure), `before_run` (fatal to the attempt), `after_run` (logged,
ignored), `before_remove` (logged, ignored). Executed with the workspace as `cwd` via a
**non-login** shell (`bash -c`) and the scrubbed environment of Section 15.2, bounded by
`hooks.timeout_ms` (default 60000).

## 7. Cost Control

Budgets are enforced, not observed. All three scopes are REQUIRED config with defaults.

### 7.1 Budget Scopes

- `budget.per_attempt_tokens` (default 400000): the runner terminates the attempt at the cap;
  outcome `budget_exhausted` with partial handoff preserved.
- `budget.per_issue_usd` (default 10.00): cumulative across all attempts and reviews for the
  issue. Exhaustion → `Human(budget_exhausted)`. Nothing dispatches for the issue until the
  operator raises its budget or resets it.
- `budget.daily_usd` (default 50.00): fleet-wide, rolling 24h. Exhaustion pauses new dispatch
  (running attempts finish), fires a notification, and resumes automatically when the window
  clears.

### 7.2 Accounting

Token usage is extracted from adapter events using absolute totals with delta tracking (never
double-count; ignore delta-style payloads for totals). `cost_usd` is computed from the adapter's
configured price table and finalized at attempt exit. Per-issue cost is the sum over its attempts
and MUST be answerable from the durable store with one query. Aggregates (daily spend, spend by
role/class/profile) are derived from the same records.

### 7.3 Budget-Aware Routing

Remaining issue budget is a routing input: an escalation or specialist fan-out whose expected cost
(profile-based estimate) exceeds remaining budget routes to `Human(budget_exhausted)` instead of
silently running. Escalations never lower deterministic risk floors; budgets never raise autonomy.

## 8. Compute Routing

Logical profiles `economy`, `standard`, `deep` map to provider `model` + `reasoning_effort` in the
agent adapter (never in workflow policy, so the spec doesn't rot when providers rename models).

- Each attempt pins one profile at dispatch; the model never changes inside a thread.
- Role defaults: `plan_review`: economy; `implementation`: by change class (Section 4);
  `integrative_review`: standard; `specialist_review`, `adjudication`, and `synthesis`: deep.
- Deterministic risk-floor rules raise the floor; a heuristic or model classifier MAY raise,
  MUST NOT lower.
- At most `agent.max_escalations` (default 1) per issue: a fresh attempt on a stronger profile,
  seeded only with the structured factual handoff. Escalate when an attempt exposes new risk,
  contradicts evidence, or repeats a failure — and only if budget allows (Section 7.3).
- Selected profile, resolved model, effort, and triggering rule ids are pinned on the attempt and
  visible in events.

## 9. Review

### 9.1 Pipeline

1. Deterministic checks first: CI status, diff scope vs. plan, verify-command evidence present,
   PR/branch hygiene. Failures route to rework without spending review tokens.
2. One **integrative review** (fresh context) over the full diff and acceptance criteria —
   required for `standard` and `high_risk`. Inputs: issue, acceptance criteria, diff, changed
   files, check results, repo docs. Excluded: builder narrative, self-review, claims of
   correctness.
3. **Specialists** fan out only on deterministic triggers, up to `review.max_parallel_specialists`
   (default 2), on the same immutable SHA. Default slices: `systems_security` (security,
   data integrity, concurrency, failure modes) and `architecture_product` (API coherence,
   maintainability, product behavior).
4. Findings are unioned and deduplicated by (affected behavior, evidence). **No voting.** A single
   `deep` adjudication runs only when two reviewers make explicitly contrary blocking findings
   about the same behavior; the adjudicator MUST cite evidence and MUST NOT erase an uncontested
   blocking finding.
5. Decision routes once: approve (→ merge queue), needs_rework (→ `In Progress` with findings),
   needs_human (→ `Human(human_review)`), blocked (→ `Human(blocked)`).

All review output is written as durable Review Records (Section 3.6). The merge gate reads only
those records, pinned to the reviewed SHA. A SHA change invalidates prior approvals.

### 9.2 Review Economics

Blocking findings must carry behavior + evidence + disposition; unsupported stylistic preference is
non-blocking by definition. Review spend is recorded like any attempt and reported per issue and
per class; there is no fixed percentage target — the calibration signal is the escaped-defect rate
(Section 14.2) versus review spend, examined at synthesis time.

## 10. Git, PRs, and the Merge Queue

### 10.1 Branch and PR Contract

- One branch per issue: `symphony/<sanitized-identifier>`, created from the default branch.
- One open PR per issue, created or updated by the implementation attempt; body links the issue.
  Force-pushes are permitted only to the issue's own branch.
- The PR description carries the plan summary and verification evidence (projection of durable
  records; human-readable only).

### 10.2 Human-Readable Projection

The workpad of v2 is reduced to a projection: the orchestrator MAY maintain one issue comment
summarizing plan, status, spend, guard results, and links. It is written by the orchestrator from
durable state, never parsed as an input to any decision.

### 10.3 Merge Queue

Merges are serialized fleet-wide (one at a time):

1. Eligibility: review approval recorded for the current head SHA, required checks green,
   no unresolved changes-requested review, autonomy policy permits (Section 11.1) or operator
   approved.
2. If the base branch has advanced since checks ran: update/rebase the branch, re-run required
   checks, and re-validate the approval SHA. A clean rebase with an identical diff MAY carry the
   approval forward (recorded as such); a changed diff requires fresh integrative review.
3. Merge via the repository's landing procedure; watch required post-merge/deploy checks to a
   terminal state; then move the issue to `Done`.
4. A merge failure or post-merge check failure routes to `In Progress` (rework) with the failure
   as evidence, and pauses the queue until resolved or skipped by the operator.

## 11. Humans: Autonomy, Questions, Notifications

### 11.1 Graduated Autonomy

Per change class, merge autonomy is `supervised` (default: every merge requires operator approval)
or `auto`. Rules:

- All classes start `supervised`. `high_risk` is permanently `supervised`.
- Promotion to `auto` is an explicit operator action. The system supports the decision with
  measured data: trailing escape rate, rework rate, and issue count for the class.
- Demotion is automatic and immediate: any escaped defect (Section 14.2) in a class returns it to
  `supervised` and fires a notification.
- Synthesis PRs (Section 12) and `verify: none` repositories are always `supervised`.

Operator approval is given on the PR (normal review/approve) or via the status surface; the
orchestrator detects it at reconciliation.

### 11.2 Structured Questions

`needs_input` renders the outcome's `question` into a single issue comment:

```
**Symphony needs a decision** (issue parked in Human)
<question text>
1. <option A> (default)
2. <option B>
Reply with a number or free text. First reply from an authorized operator is consumed.
```

Authorized operators are `human.operators` (list of tracker logins; REQUIRED). The first qualifying
reply is stored durably, echoed into the next attempt's context, and the issue returns to its
origin lane. `Human`-parked issues are reconciled every tick; `human.reminder_hours` (default 24)
re-notifies once.

### 11.3 Notifications

`notify.command` (shell) and/or `notify.webhook_url`. Fired on: entry to `Human` (any reason),
daily budget exhaustion, autonomy demotion, merge-queue pause, synthesis PR opened, and service
startup validation failure. Payload: issue identifier/URL, reason, one-line summary, spend so far.

## 12. Learning Loop

### 12.1 Lesson Capture

The orchestrator writes Lessons (Section 3.8) automatically for: guard denials, rework cycles
(with the triggering findings), blocking review findings, escaped defects, plan rejections,
repeated tool failures, budget exhaustions, and every `confusions` entry from outcomes. No agent
cooperation is required beyond the outcome contract.

### 12.2 Synthesis

After every `learning.interval_issues` (default 25) completed issues — or on operator demand — the
orchestrator dispatches one `synthesis` attempt (deep profile). Inputs: lessons since the last
synthesis, current prompt and rules with citation counts, and per-class quality/cost metrics.
Output: a PR editing the workflow prompt's rules block and, where justified, repo docs — plus a
summary of proposed rule additions/removals with cited lesson ids.

The synthesis PR flows through the normal Review lane and is always `supervised`. Self-improvement
is gated exactly like code.

### 12.3 Saturation Controls

- `learning.max_rules` (default 25) and `learning.max_prompt_tokens` (default 4000) are hard caps.
- At the cap, adding a rule requires removing or merging one; the synthesis output must say which
  and why.
- Every rule cites its lessons. The orchestrator increments `citation_count` when a rule's id is
  referenced by a guard denial, routing decision, or review finding.
- Rules uncited for `learning.rule_decay_issues` (default 100) completed issues MUST be proposed
  for removal at the next synthesis. Evidence-free rules do not accumulate.

## 13. Failure Handling and Retries

Every failure maps to one class:

- `infrastructure` — tracker/network outage, provider capacity, rate limits. Retried with
  exponential backoff + jitter (base 10s, cap `agent.max_retry_backoff_ms`, default 300000),
  honoring provider retry-after. **Never charges the issue's failure budget.** Persistent
  infrastructure failure (>1h) fires a notification.
- `agent_process` — crash, protocol violation, timeout, stall, malformed outcome. Retried within
  `agent.max_failure_retries` (default 2) per issue cycle.
- `configuration` / `auth` — not retryable; dispatch pauses (config) or the issue parks
  (`Human(blocked)`) until the named fact changes. Repeating a non-retryable failure without new
  evidence is prohibited.
- `policy` — denied side effect, unsafe path, injection boundary. Not automatically retryable;
  always produces a lesson.
- `task` — deterministic test failures, unreconcilable criteria. Not a retry; routes through
  outcomes (`needs_rework` / `needs_input` / `blocked`).

Stall detection: no adapter event for `agent.stall_timeout_ms` (default 300000) → kill and retry.
Restart recovery: reload leases/attempts before dispatch; close attempts interrupted without a
durable outcome as `agent_process`; reconcile side-effect intents by idempotency key; compare
tracker, store, and workspace ownership before any re-dispatch; never assume an old process
survived.

Every external mutation carries an idempotency key (issue, attempt, action, target revision) and is
committed as an intent before it is applied.

## 14. Observability and Quality Measurement

### 14.1 Required Surfaces

- **Structured logs** with `issue_id`, `identifier`, `attempt_id`, `session_id` on all
  issue-scoped entries. Startup/validation/dispatch failures MUST be visible without a debugger.
- **Event records** (append-only table, exportable as JSONL): lane transitions, dispatches with
  routing reasons, outcomes, guard decisions, review decisions, merges, budget events, autonomy
  changes, syntheses. Every event carries `issue_id`, `attempt_id`, `change_class`,
  `compute_profile`, `cost_usd`, `timestamp`. Events MUST NOT contain prompts, diffs, or secrets.
- **Cost queries**: per-issue, per-class, per-role, and daily spend answerable from the store.

Retention: `persistence.event_retention_days` (default 90) MUST NOT remove active-issue evidence,
quality metrics, or lessons.

### 14.2 Quality Metrics (the other Pareto axis)

An **escaped defect** is: a revert of a Symphony merge; a subsequent fix PR linked to the same
issue or touching the same files within `quality.escape_window_days` (default 14) and flagged by
the operator or the sampled audit; or a blocking finding from a sampled audit (Section 4).

Tracked per change class and compute route: escape rate, rework cycles per accepted issue,
plan-rejection rate, cost per accepted issue, and review spend per accepted issue. These numbers
drive autonomy promotion evidence, risk-floor tuning, and synthesis — they are the point of the
whole exercise: cost per accepted issue on one axis, escape rate on the other.

### 14.3 Optional HTTP Surface

If shipped: `GET /api/v1/state` (running, queued, parked, budgets, totals),
`GET /api/v1/issues/<identifier>` (attempts, costs, outcomes, events), `GET /api/v1/quality`
(Section 14.2 metrics), `POST /api/v1/refresh`. Read-only besides `refresh`; loopback bind by
default; never required for correctness.

## 15. Security

### 15.1 Trust Boundaries

Issue text, PR comments, repository contents, tool output, and fetched content are untrusted
input. Policy lives in the orchestrator and config, never delegated to those inputs. Agents hold
no tracker, repo-hosting, or control-plane credentials; all mutations flow through the
orchestrator's typed adapters with authority checks, revision pinning, idempotency, and audit.
Broad passthrough tools (raw GraphQL execution in-session) are not part of this specification.

### 15.2 Secrets and Environment

- Config secret values MUST use `$VAR` indirection. Literal tokens in `WORKFLOW.md` are a
  validation error.
- Agent and hook processes receive a scrubbed environment: `env.allowlist` (plus PATH/HOME/locale
  baseline), launched via non-login shells. The orchestrator's environment is never inherited
  wholesale.
- Secrets are resolved at the adapter boundary, never persisted in snapshots, prompts, handoffs,
  events, or logs; tool results are filtered for credential patterns before entering model context
  or durable records.

### 15.3 Config-Change Acknowledgment

`WORKFLOW.md` is repo-owned and hot-reloaded — and agents modify the repo. Therefore: a reload
that changes `hooks.*`, `agent.command`, `env.allowlist`, or `human.operators` takes effect only
after explicit operator acknowledgment (CLI/status-surface confirm). All other changes hot-reload
freely. Invalid reloads keep the last known good config and emit an error. This closes the loop
where merged agent output becomes trusted shell.

### 15.4 Sandboxing

The agent adapter's approval/sandbox settings are configuration, and each deployment MUST document
its posture. Approval requests and user-input signals from the agent protocol MUST NOT stall a run
indefinitely: satisfy, surface, or fail them per documented policy. Additional OS/container
isolation, dedicated users, and restricted workspace volumes are recommended and
deployment-specific.

## 16. Tracker Adapter Contract

Required operations: `fetch_candidates()`, `fetch_states_by_ids(ids)`,
`fetch_issues_by_states(states)` (startup cleanup), `update_issue_lane(id, lane, reason)`,
`create_or_update_comment(id, marker, body)` (projection + questions),
`fetch_comments_since(id, ts)` (answers), `fetch_pr_snapshot(id)` (head SHA, base, checks,
reviews, unresolved threads), plus merge support for the queue.

Adapter errors follow Section 13 (`infrastructure` unless clearly `auth`/`configuration`).
Candidate-fetch failure skips a tick; state-refresh failure keeps workers running.

**GitHub reference profile**: Issues + Projects v2; the Project single-select `Status` field is the
lane source of truth (lane names of Section 5.1 as options); `Priority` field for ordering; native
`blockedBy` for dependencies; `gh`/App auth (never tokens in config); one repository per workflow
unless multi-repo is explicitly supported. Other trackers (e.g., Linear) implement the same
contract; normalization per Section 3.1 (labels lowercased, ISO-8601 timestamps, blockers with
states).

## 17. Agent Adapter Contract

Each provider integration is a versioned adapter that publishes: supported protocol range, price
table per model, profile→(model, effort) mapping, and normalized event mapping. The adapter MUST:

- Launch the subprocess in the workspace with scrubbed env; speak the provider protocol over its
  transport; verify protocol/capability compatibility **before** an attempt is charged.
- Stream normalized events (`session_started`, `turn_completed`, `turn_failed`, token usage,
  rate limits) through a bounded channel with backpressure or fail-fast overflow.
- Enforce read, turn, and token limits; expose one schema-constrained terminal-outcome channel
  (a `report_outcome` tool or protocol equivalent). If a session ends without an outcome, the
  adapter SHOULD attempt one minimal outcome-elicitation turn on the economy profile before the
  orchestrator declares `agent_process` failure — finishing cheap beats re-running everything.
- Terminate the full process tree and confirm exit on any end state.

**Codex app-server reference profile**: `agent.command` default `codex app-server` over stdio;
the installed Codex version's generated schema is the protocol source of truth; approval/sandbox
values pass through to Codex settings; thread reuse for continuation turns within one attempt;
`session_id = <thread_id>-<turn_id>`.

## 18. WORKFLOW.md

One repo-owned file: YAML front matter (config) + Markdown body (the implementation prompt
template, rendered strictly — unknown variables fail — with `issue`, `attempt`, `change_class`,
and `rules` available). The synthesized rules block (Section 12) lives in the body between
`<!-- rules:start -->` and `<!-- rules:end -->` markers.

Front matter keys (defaults per the sections above):

```yaml
tracker:        # kind, owner, project_number, repo_owner, repo_name, status/priority fields
polling:        # interval_ms
workspace:      # root, verify_command (REQUIRED), verify_none_reason
hooks:          # after_create, before_run, after_run, before_remove, timeout_ms
agent:          # command, max_concurrent, max_turns, turn_timeout_ms, stall_timeout_ms,
                # max_failure_retries, max_rework_cycles, max_escalations, max_retry_backoff_ms
budget:         # per_attempt_tokens, per_issue_usd, daily_usd
compute:        # profiles {economy|standard|deep -> model, effort}, risk_floor_rules
class:          # trivial_max_changed_lines, trivial_patterns, risk_paths
review:         # max_parallel_specialists, specialists[]
quality:        # audit_rate, escape_window_days
learning:       # interval_issues, max_rules, max_prompt_tokens, rule_decay_issues
human:          # operators (REQUIRED), reminder_hours
notify:         # command, webhook_url
env:            # allowlist
persistence:    # database_path, lease_ttl_ms, event_retention_days
server:         # port, host (optional surface)
```

Unknown keys are ignored. Startup validation failure fails startup; per-tick validation failure
skips dispatch. Dynamic reload per Sections 3.5 and 15.3.

## 19. Implementation Checklist

Required:

- Workflow loader, strict prompt rendering, immutable snapshots, categorized reload +
  acknowledgment for privileged keys
- Single-writer SQLite store: claims/leases, attempts **with cost**, outcomes, guard decisions,
  review records, lessons, rules, quality metrics, events, side-effect intents/receipts
- Poll/dispatch/reconcile loop with transactional claims, `AwaitingHuman` parking, restart
  recovery, and startup cleanup
- Change classification, plan gate (per class), verification enforcement at `completed`
- Budgets at all three scopes with enforcement and budget-aware routing
- Compute profiles, risk floors, single budgeted escalation with factual handoff
- Review pipeline with durable records, SHA pinning, no-voting merge of findings, sampled audits
- Branch/PR contract and serialized merge queue with base re-validation
- Graduated autonomy with automatic demotion; structured questions; notifications
- Lesson capture, periodic synthesis via gated PR, saturation caps with citation decay
- Failure taxonomy with infrastructure/task separation; idempotent side effects; process-tree
  cleanup verified on every end state
- Structured logs, event records, cost and quality queries
- Secret indirection, scrubbed env, non-login shells, injection boundaries

Optional: HTTP status surface (14.3), webhook-triggered ticks, additional tracker/agent adapters.

Tests SHOULD cover, at minimum: claim atomicity and restart recovery; budget termination at each
scope; plan-gate routing per class; outcome routing including malformed outcomes; merge-queue
base-advance re-validation; autonomy demotion on escaped defect; guard refusal of comment-only
"evidence"; rule cap displacement and decay; env scrubbing; and process-tree termination.

## Appendix A. Changes from v2

Cut: nine lanes → six (rework/blocked/questions became attributes); conformance profiles and
reports; the redundant config cheat sheet; SSH worker appendix; broad `linear_graphql` /
`github_graphql` tools; per-state concurrency map; workpad-as-input (now projection-only);
humanized event summaries; ~70% of the text.

Fixed: cost is now durable on attempts and enforced by three budget scopes (was
observability-only); merge decisions read durable review records (was regex-parsed tracker
comments); the phase/attempt contradiction (one profile per attempt, phases are roles);
infrastructure failures no longer charge issue retry budgets; the `Blocked`-claim hole in the
state machine (`AwaitingHuman`); login-shell env leakage; literal secrets in config;
hook-change privilege escalation (acknowledgment gate); provider-named fields in the core model.

Added: plan gate with issue-readiness routing; change classes and proportional process; required
verification loop; merge queue with base re-validation; graduated autonomy with automatic
demotion; structured questions and notifications; lessons, synthesis agent, and rule saturation
controls; escaped-defect definition and per-class quality metrics; outcome-elicitation salvage
turn; `budget_exhausted` and `plan_ready` outcomes.
