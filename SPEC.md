# Symphony Encore Service Specification

Status: Draft v3

Purpose: Define a durable, cost-controlled service that orchestrates coding agents to complete
tracker issues with verified evidence, bounded spend, proportional process, and independent review —
and that improves itself from its own operating history.

Symphony Encore is a scheduler, durable control plane, policy enforcer, and agent runner. Agents may
edit files only inside their assigned workspace. They propose typed terminal results and requests
for privileged external actions; the orchestrator validates them and exclusively owns tracker,
repository-hosting, control-plane, notification, and merge mutations. A successful run ends at a
workflow-defined handoff state, not necessarily `Done`.

The key words MUST, MUST NOT, SHOULD, and MAY are used per RFC 2119. Domain schemas, enums, state
transitions, configuration tables, required operations/surfaces, and the Core test matrix are also
normative contracts. Text explicitly labeled guidance, example, or rationale is non-normative.

## 1. Design Principles

Every requirement in this document traces to one of these. When a future change conflicts with a
principle, change the principle deliberately or reject the change.

1. **Feedback over procedure.** Agents are constrained by ground-truth verification (runnable
   tests, small diffs, early plan checks), not by ceremony. Procedure can be satisfied
   ceremonially; feedback cannot be faked.
2. **Cost is a control input, not a metric.** Budgets stop work. Spend is recorded durably per
   Attempt, issue, SystemJob, and rolling fleet window; remaining budget influences routing.
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
   usage/cost), terminal records, stages, retries, parked work, budgets, logs/events, guard and review
   records, lessons, quality metrics, config/override history, operator actions, and side-effect
   intents/receipts.
4. **Workspace Manager** — issue and SystemJob directories under a configured root, repository
   population, lifecycle hooks, quarantine, and cleanup.
5. **Agent Runner** — launches the coding-agent subprocess in the workspace, streams events,
   enforces timeouts/turn caps/token caps, accepts at most one schema-valid Attempt-role terminal
   result, reports missing/duplicate results as failure, and terminates the full process tree.
6. **Review Coordinator** — runs deterministic checks, dispatches the integrative reviewer and any
   risk-triggered specialists, merges findings without voting, records durable review records.
7. **Merge Queue** — serializes merges per repository; re-validates against the current base before
   each merge.
8. **Tracker and Repository-Hosting Adapters** — normalize tracker reads and perform authorized,
   revision-pinned tracker, Git-hosting, pull-request, and merge mutations.
9. **Learning Synthesizer** — periodically distills lessons into proposed prompt/rule changes,
   submitted through the same review pipeline as code.
10. **Notifier** — fires the configured notification hook on events that need a human.
11. **Operator Control API and UI** — authenticated control operations plus a required browser UI
    over the same durable state used by orchestration.
12. **Observability** — structured logs, append-only event records, durable history, and stage
    timing, all visible through the required UI.

External dependencies: an issue tracker and repository host (GitHub Issues + Projects v2 plus GitHub
PRs is the reference; adapters may target others), a coding-agent executable speaking a supported
adapter protocol (Codex app-server is the reference), Git, local SQLite/filesystem storage, and an
operator browser for the required UI.

## 3. Domain Model

Only fields that decisions depend on are normative. Adapters may carry extra data.

### 3.1 Issue (normalized)

`id`, `identifier` (human key), `title`, `description`, `acceptance_criteria[]`, `state` (lane),
`labels` (lowercased), `priority` (integer or null; lower dispatches first),
`blocked_by` (list of `{id, state}`),
`assignee_id`, `repo_owner`, `repo_name`, `url`, `created_at`, `updated_at`.

### 3.2 Attempt

One dispatched agent run. Every attempt has exactly one **role** and one pinned compute profile.

Roles: `plan_review`, `implementation`, `integrative_review`, `specialist_review`, `adjudication`,
`synthesis`.

Fields: `id`, `work_ref` (exactly one of `issue_id` or `system_job_id`), `role`, `attempt_number`,
`workspace_path`, `config_snapshot_id`, `compute_profile`, `model`, `reasoning_effort`,
`price_table_version`, `routing_reasons` (rule ids), `change_class`,
`started_at`, `ended_at`, `status`, `terminal_result_id`, `failure_class`,
**`input_tokens`, `output_tokens`, `total_tokens`, `cost_usd`** (tokens update as events stream;
`cost_usd` derives from the pinned adapter price table and is finalized at exit).

Attempt `status` is `created` | `running` | `awaiting_human` | `closed`; a closed Attempt has exactly
one terminal record. `ended_at` is null until closed.

Token fields are REQUIRED on every durable attempt. `cost_usd` is REQUIRED when the adapter has a
price table and null otherwise; an unpriced adapter uses the token budgets defined in Section 7.

### 3.3 Implementation Outcome

An implementation agent that reaches the terminal-result channel submits exactly one structured
ImplementationOutcome. Free-form prose is not a conforming result. If the agent process ends before
a valid result, the orchestrator closes the Attempt with the ExecutionFailure from Section 3.17.

`status`: one of
`completed` | `plan_ready` | `needs_rework` | `blocked` | `needs_input` | `no_progress` |
`budget_exhausted` | `failed`.

Fields: `status`, `summary`, `evidence` (typed refs: commands run with results, files, commits, PR,
checks), `verification` (result of the workspace verify command — REQUIRED for `completed`
implementation attempts), `question` (REQUIRED for `needs_input`: `{text, options[], default}`),
`actions_requested` (typed requests for orchestrator-owned external mutations),
`confusions` (short list; feeds lessons), `handoff` (facts for a fresh session: goal, acceptance
criteria, revision, files changed, commands+results, decisions fixed, open items — never hidden
reasoning or claims of correctness).

The orchestrator maps outcomes to transitions (Section 5.4); agents never mutate tracker state.

### 3.4 Claim / Lease

One schema owns both issue and SystemJob execution. Fields: `work_ref` (exactly one of `issue_id` or
`system_job_id`), `holder`, `mode`, `acquired_at`, `updated_at`, `expires_at` (running leases only),
`origin_stage`, `reason`, `retry_due_at`, `blocker_predicate`, `question_id`,
`approval_request_id`, and nullable `last_comment_cursor` (issue work only).
States: `Unclaimed` → `Claimed` → `Released`.

A claimed work item is in exactly one of four claim modes:

- `Running` — an attempt is executing; consumes a concurrency slot.
- `Ready` — the next plan, implementation, review, or merge action is durably queued; consumes no
  slot. Restart recovery re-enqueues the action from the work stage and latest terminal record.
- `RetryQueued` — a retry timer exists; consumes no slot.
- `AwaitingHuman` — parked pending operator input/review/unblock; consumes no slot. Reconciled
  each tick; released if the work item goes terminal.

Claims are acquired transactionally before any worker launch. A `Running` lease MUST be renewed
before expiry; an expired running lease enters restart reconciliation and is never blindly resumed.
`Ready`, `RetryQueued`, and `AwaitingHuman` are durable reservations, not expiring process leases.
The Claim remains held across role changes, review, merge queuing, retries, and Human parking and is
released only on terminal state or operator cancellation. A running Attempt closes atomically with
the next claim mode, preventing an unowned gap between stages. For SystemJobs, terminal state is
`done`, `failed`, or operator cancellation and no tracker lane or comment cursor is synthesized.
Restart recovery MUST rebuild ready work, timers, and reconciliation cursors from these fields.
Claim acquisition and renewal use `work_ref` as the unique ownership key, so duplicate dispatch is
impossible for issues and SystemJobs alike.

### 3.5 Configuration Snapshot

Immutable record: `id`, `created_at`, `workflow_source_hash`, `operator_override_revision`,
`effective_config` (secrets as references, never values), per-key source/version metadata,
acknowledgment and restart state, `prompt_hash`, `adapter_versions`. Every attempt and SystemJob pins
exactly one snapshot. Hot settings apply to the live scheduler after validation; attempt settings
apply only to new work; restart settings remain pending. Ack-modified settings remain pending until
the exact candidate version is acknowledged (Sections 15.3 and 18.3).

### 3.6 Review Record

Durable, orchestrator-written: `id`, `work_ref`, `attempt_id`, `reviewer_role`, `target_sha`,
`target_base_sha`, `patch_identity`, `decision`
(`approve` | `needs_rework` | `needs_human` | `blocked`), `findings[]`
(`{id, behavior, severity, evidence, disposition, blocking}`), `created_at`.

**Guards read review records and guard decisions from the store only.** A review result that exists
only in a tracker comment does not exist.

`ReviewSet` is the durable aggregate consumed by the merge gate: `id`, `work_ref`, `target_sha`,
`target_base_sha`, `patch_identity`, `required_reviewer_roles[]`, `required_specialist_names[]`,
`verification_record_id`, `guard_decision_ids[]`, `review_record_ids[]`,
`unresolved_blocking_finding_ids[]`, nullable `carried_from_review_set_id`, nullable
`carry_forward_guard_decision_id`, `decision`
(`approve` | `needs_rework` | `needs_human` | `blocked`), `created_at`. The Review Coordinator writes
one only after deterministic checks finish. In an ordinary ReviewSet both carry-forward fields are
null and every reviewer required by the class and matching specialist rules has a terminal Review
Record for the same immutable revision. In a Section 10.3 carried ReviewSet both carry-forward fields
are non-null: the linked prior ReviewSet MUST be `approve`, have the identical patch identity and
complete required reviewer set, and name the carried Review Records; those records may target only
that prior set's head. The carry-forward Guard Decision proves those facts. The carried ReviewSet's
Verification Record and all other Guard Decisions MUST target its new head/base. No other
cross-revision record is valid.

`approve` requires a passing current Verification Record, allowing current guards, the complete
required reviewer set (which may be empty for `trivial`), and no unresolved blocking finding. Any
target-SHA or patch-identity change invalidates that ReviewSet. Section 10.3 may create a new
current-revision ReviewSet under the narrow carried invariant above; only that new set is
merge-eligible.

### 3.7 Guard Decision

Durable: `id`, `work_ref`, `requested_transition`, `result` (`allow` | `deny`), `reason_code`, `evidence
refs`, `created_at`. Denials route per Section 5.4 and emit a lesson when caused by agent output.

### 3.8 Lesson

Append-only: `id`, `created_at`, `work_ref`, `source`
(`guard_denial` | `rework` | `review_finding` | `escaped_defect` | `plan_rejection` |
`tool_failure` | `budget_exhausted` | `confusion`), `text`, `evidence refs`. Input to synthesis
(Section 12).

### 3.9 Rule

A numbered, synthesized instruction in the workflow prompt's rules block: `id`, `text`,
`lesson_ids`, `citation_count`, `last_cited_at`. Subject to the saturation caps in Section 12.3.

### 3.10 Live Session

Durable process and protocol identity for a running attempt: `attempt_id`, `session_id`, `thread_id`,
`turn_id`, `process_id`, `process_group_id`, `adapter_version`, `protocol_schema_hash`,
`last_event`, `last_event_at`, `turn_count`, last reported absolute token totals, and
`ownership_verified_at`. Process handles are ephemeral; these fields are the evidence used to find,
terminate, or classify abandoned processes after restart.

### 3.11 Retry Entry and Parked Work

`RetryEntry`: `work_ref`, `attempt_id`, `failure_class`, `retry_number`, `due_at`, `max_retries`,
`last_error`, `created_at`. Runtime timers are rebuilt from `due_at`.

`ParkedWork`: `work_ref`, `origin_stage`, `reason`, `blocker_predicate`, `question_id`,
`parked_at`, `last_checked_at`, `resolved_at`. A blocker predicate MUST name an observable fact the
orchestrator can re-check; otherwise only an authorized operator can resolve it.

### 3.12 Operator Question and Answer

`OperatorQuestion`: `id`, `work_ref`, `attempt_id`, `text`, `options`, `default`,
`comment_marker`, `comment_cursor`, `asked_at`, `reminded_at`, `answered_at`, `answer`,
`answered_by`. Only the first answer from an authorized operator is accepted; later replies remain
visible but do not change the durable answer.

`AgentApprovalRequest`: `id`, `work_ref`, `attempt_id`, `action_kind`, `scope`, `summary`,
`requested_at`, `expires_at`, `status`, `decided_at`, `decided_by`, `decision`. It contains no raw
credential or unbounded tool payload.

### 3.13 Stage Transition

Append-only: `id`, `work_ref`, `from_stage`, `to_stage`, `reason`, `attempt_id`,
`confirmed_external_revision`, `entered_at`, `exited_at`, `duration_ms`. Issue stages are confirmed
tracker lanes; SystemJob stages are durable statuses. `timestamp_source` is `receipt`, `tracker`, or
`observed_estimate`. `from_stage` is null only for a baseline transition. `attempt_id` is nullable for
baseline, operator-observed, reconciliation, and other orchestrator transitions; when present it
must refer to an Attempt with the same `work_ref`. The open transition has null `exited_at` and
`duration_ms`. Closing one transition and opening the next is atomic, so time in each stage remains
reconstructable after restart.

### 3.14 External Side Effect

`MutationAuthorization`: `id`, `intent_id`, `idempotency_key`, `scope` (`work` | `fleet`), nullable
`work_ref`, `service_run_id`,
`actor_kind` (`orchestrator_policy` | `operator`), `actor_id`, nullable `attempt_role`, nullable
`operator_capability`, `config_snapshot_id`, `action`, `target`, `observed_state_ref`, nullable
`target_revision`, `decision_rule_ids[]`, `authorized_at`, and `expires_at`. Work scope requires
`work_ref`; fleet scope requires a fleet target and `service_run_id`. `observed_state_ref` identifies
the immutable tracker/repository/control snapshot used by the decision. An authorization is valid
only for its exact intent/key, actor, action, target, configuration, observed state, and revision.
`target_revision` may be null only when creating a target that does not exist; then
`observed_state_ref` and the parent/container revision are required.

`SideEffectIntent`: `id`, `idempotency_key`, `scope` (`work` | `fleet`), nullable `work_ref`,
`service_run_id`, nullable `attempt_id`, `action`, `target`, nullable `target_revision`,
`request_payload_hash`, `authorization_id`, `status`
(`pending` | `applying` | `applied` | `failed` | `unknown`), `created_at`, `updated_at`.

`SideEffectReceipt`: `intent_id`, `provider_request_id`, `result`, `result_revision`,
`response_payload_hash`, `applied_at`. The orchestrator MUST commit an authorized intent before the
adapter call and MUST commit a receipt afterward. On restart, an intent without a receipt is queried
by its idempotency key before it is retried. Every mutating tracker, repository-hosting,
notification, and other external adapter call MUST receive the same persisted
MutationAuthorization and MUST reject a missing, expired, mismatched, or stale envelope.

### 3.15 Operator Action and Repository Link

`OperatorAction`: `id`, `operator_id`, `auth_subject`, `capability`, `endpoint`, `action`, `target`,
`reason`, `expected_version`, `observed_version`, `idempotency_key`, `request_payload_hash`, `result`
(`accepted` or a typed rejection code), `created_at`. UI and API mutations always create this
record, including every rejected request made after successful authentication.

An idempotency key is scoped to `(operator_id, endpoint, target)` and bound to the request payload
hash. Reuse with the same payload returns the original committed result; reuse with a different
payload returns `409 idempotency_conflict` and creates a rejected OperatorAction.

`RepositoryLink`: append-only identity/history record with `id`, `work_ref`, `cycle`, `kind`
(`primary` | `repair`), `repo_owner`, `repo_name`, `branch`, `pull_request_number`,
`pull_request_url`, `head_sha`, `base_ref`, `base_sha`, `state`, `created_at`, `updated_at`. Issue and
pull-request links shown in the UI come from these durable records; a later repair never overwrites
the original PR link.

### 3.16 Plan

Durable, versioned: `id`, `work_ref`, `revision`, `status`
(`draft` | `validated` | `approved` | `rejected` | `superseded`), `approach`,
`acceptance_criteria[]` (`{criterion_id, criterion_text, planned_evidence}`), `proposed_paths[]`,
`verification_commands[]`, `estimated_files`, `estimated_changed_lines`, `risk_facts[]`,
`created_by_attempt_id`, `created_at`, `validated_at`, `approved_by_attempt_id`.

The agent submits the Plan through a schema-constrained tool. The orchestrator writes `PLAN.md` as a
human-readable workspace projection and MAY refresh it after validation; neither the orchestrator
nor a guard parses free-form Markdown to recover plan facts.

### 3.17 Role Terminal Results and System Jobs

- `PlanReviewResult`: `decision` (`approve` | `needs_rework` | `needs_input`), `plan_revision`,
  `findings[]` (`{id, behavior, severity, evidence, blocking}`), nullable `question`, `evidence`,
  `handoff`. `needs_rework` requires at least one blocking finding; `needs_input` requires the
  Section 3.3 question schema; `approve` forbids both a blocking finding and a question.
- `ReviewResult`: `decision` (`approve` | `needs_rework` | `needs_human` | `blocked`), `target_sha`,
  `findings[]` using the Review Record finding schema, `evidence`; `approve` forbids blocking
  findings and every other decision requires evidence explaining its route.
- `AdjudicationResult`: `target_sha`, `conflict_ids[]`, `decision` (`resolve` | `needs_human`),
  `resolutions[]` (`{conflict_id, upheld_finding_ids[], rejected_finding_ids[], rationale,
  evidence}`), nullable `question`, `evidence`. `resolve` requires exactly one resolution for every
  conflict id; `needs_human` requires a question. It cannot erase an uncontested blocking finding.
- `SynthesisResult`: `decision` (`propose_changes` | `no_change` | `needs_input`), `rule_changes[]`
  (`{action: add|update|remove, rule_id, text, lesson_ids[], rationale}`), `cited_lesson_ids[]`,
  nullable repository revision, branch, pull-request request, question, evidence, and handoff.
  `propose_changes` requires a non-empty change list and repository/PR fields; `no_change` requires
  evidence and forbids repository/PR fields; `needs_input` requires a question.
- `ExecutionFailure`: orchestrator-authored `status` (`failed` | `budget_exhausted`), Attempt role,
  `failure_class`, `summary`, `evidence`, and latest durable `handoff`. It closes an Attempt that did
  not produce a valid result or that the runner terminated at a hard cap.

Every Attempt has exactly one terminal record: its valid role result or an ExecutionFailure. The
orchestrator atomically closes the attempt and writes that record plus any Review Record. A role MUST
NOT report another role's result schema.

Fleet-level and non-issue repair work is a `SystemJob`, not a synthetic tracker issue. Fields: `id`,
`kind` (`synthesis` | `repair`), nullable `parent_work_ref` (required for repair), `repository`,
`workspace_path`,
`goal`, `acceptance_criteria[]`, `config_snapshot_id`, `status`
(`queued` | `running` | `review` | `merge` | `rework` | `human` | `budget_exhausted` | `failed` | `done`),
aggregate `input_tokens`, `output_tokens`, `cost_usd`, `created_at`, `started_at`, `ended_at`, and
`final_result_id`. Every model execution for a SystemJob is an Attempt whose work reference is that
job. A synthesis Attempt returns SynthesisResult; a repair implementation Attempt returns
ImplementationOutcome. Review attempts use the same work reference. System jobs therefore reuse the
same budget, event, failure, retry, side-effect, review, and supervised merge contracts as issue work.

### 3.18 Service Run, Log Record, and Usage Sample

`ServiceRun`: `id`, `service_version`, `host_id`, `started_at`, `ended_at`, `status`,
`startup_config_snapshot_id`, `start_reason`, `end_reason`. A restart creates a new ServiceRun; it
does not replace prior history. Startup closes any previously open ServiceRun as `interrupted` after
process-ownership reconciliation.

`LogRecord`: `id`, `service_run_id`, `work_ref`, `attempt_id`, `session_id`, `stage_transition_id`,
`timestamp`, `level`, `event_name`, `message`, `structured_fields`. Agent commands, tool actions,
verification output, file-action summaries, review activity, and orchestrator decisions MUST be
logged with enough structure for the UI to show what happened at each stage. Secrets, full prompts,
hidden reasoning, and unbounded raw payloads MUST NOT be stored.

`UsageSample`: `id`, `service_run_id`, `work_ref`, `attempt_id` or `system_job_id`, `timestamp`,
absolute `input_tokens`, `output_tokens`, `total_tokens`, `billable_categories`, derived deltas, and
`cost_usd`. Samples plus
Attempt/SystemJob totals and StageTransitions preserve token and elapsed-time history durably.

### 3.19 Budget Ledger

`BudgetLedger`: `scope` (`attempt` | `issue` | `rolling_24h`), scope id, `unit`
(`tokens` | `usd`), `base_limit`, `adjustment`, `effective_limit`, `reserved`, `consumed`, `overrun`,
`remaining`, `version`, `updated_at`. `BudgetReservation`: `id`, `ledger_refs[]`, `work_ref`,
`attempt_id` or
`system_job_id`, `estimated_amounts`, `actual_amounts`, `status`, timestamps.

`BudgetAdjustment`: `id`, ledger target, `action` (`set_limit` | `add_allowance` |
`start_new_allowance_epoch`), amount, reason, operator action id, prior version, new version, and
timestamp. A reset starts a new allowance epoch; it never rewrites or deletes historical usage.

### 3.20 Verification Record

Orchestrator-authored: `id`, `work_ref`, `attempt_id`, `config_snapshot_id`, `target_revision`,
`command_hash`, `started_at`, `ended_at`, `exit_code`, `result` (`passed` | `failed` | `error`),
bounded stdout/stderr references, and environment-policy hash. Guards and reviewers use this record,
not an agent's assertion that verification passed.

## 4. Change Classes and Proportional Process

Every issue receives a conservative provisional routing class before its first implementation
attempt. The orchestrator derives it from tracker metadata, repository metadata, configured
path/label rules, and the issue's structured acceptance criteria. Unknown facts select `standard`
for initial compute routing but are not an irreversible standard-risk fact; ambiguous acceptance
criteria are an explicit `high_risk` fact.

- `trivial` — every proposed and changed path matches `class.trivial_patterns`, changed lines are at
  most `class.trivial_max_changed_lines` (default 25), and no risk path/fact is present. The default
  empty pattern list classifies no issue as trivial.
- `standard` — the default.
- `high_risk` — matches any risk rule: security boundaries, auth, migrations, concurrency,
  public API changes, cross-package architecture, configured sensitive paths, or ambiguous
  acceptance criteria.

After the Plan is validated, the orchestrator computes the first authoritative class from the Plan's
proposed paths and size plus every explicit provisional fact. A provisional `standard` caused only
by facts that the pre-plan phase could not know may therefore become authoritative `trivial`; a
provisional explicit standard/high-risk fact remains a floor. The orchestrator recomputes after every
material diff change. Classification inputs MUST be observable facts (paths, labels, diff size,
dependency graph, structured issue fields, configured issue-text patterns) — never agent
self-assessment. Upward-only monotonicity begins when the first authoritative class is committed:
within that execution cycle it may move upward but never downward. Before work continues, an upward
move MUST apply every newly required plan review, compute floor, specialist review, and merge
restriction.

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
  `agent_approval`, `blocked`, `budget_exhausted`, `no_progress`. Consumes no agent slot.
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
2. Reconcile issue and SystemJob `AwaitingHuman` claims plus their ParkedWork records (answered?
   unblocked? terminal?).
3. Advance the merge queue (Section 10.3).
4. Validate config; on failure skip dispatch this tick but keep reconciling.
5. Fetch candidates, sort (priority, then oldest `created_at`, then identifier), dispatch while
   global slots (`agent.max_concurrent`, default 4) and budgets allow.
6. Check the learning trigger (Section 12.2) and rolling fleet budgets (Section 7.1).

Tracker adapters SHOULD support a webhook or event-stream trigger for an immediate tick;
polling is the required baseline.

Candidate eligibility requires the configured assignee when non-null, every lowercased
`tracker.required_labels` value, a dispatchable lane, satisfied blockers, an unclaimed issue, an
available slot, and a successful required-skill preflight. Blank required labels are invalid.
Removing an assignee/required-label match during execution makes the issue ineligible at the next
reconciliation and stops the worker without workspace cleanup. Named tracker priorities normalize
to integers by first match in `tracker.priority_order`; unknown/blank values become null and sort
last.

On first observation, the orchestrator opens a baseline StageTransition for the tracker lane using
the tracker's state-change timestamp when available, otherwise the observation time marked as
estimated. Reconciliation of an operator-made external lane change atomically closes the prior stage
and opens the observed stage with the same timestamp rule. The UI identifies estimated boundaries.

### 5.3 Implementation Attempt Flow

1. Compute the provisional change class; select its compute route; commit the config snapshot;
   reserve budget; transactionally acquire the lease and create the Attempt. Commit and apply the
   `In Progress` lane-change intent through the tracker adapter, then open the StageTransition only
   after its receipt. A failed/unconfirmed lane mutation prevents worker launch.
2. Prepare workspace (Section 6); run `before_run` hook.
3. **Plan first.** Before changing code, the agent submits the typed Plan from Section 3.16. The
   orchestrator validates its schema and acceptance-criterion coverage, computes the authoritative
   class, and writes the `PLAN.md` projection.
   - `trivial`: no gate; proceed.
   - `standard`: the orchestrator validates every acceptance criterion is mapped, proposed paths are
     allowed and consistent with configured scope/risk rules, commands are present, and size is
     internally consistent. Failure → one in-session revision message with the specific objection;
     second failure → `needs_input` with the objection as the question.
   - `high_risk`: the session ends with outcome `plan_ready`. A `plan_review` attempt
     (economy profile, fresh context, reads issue + durable Plan + repo — never builder narrative)
     returns `PlanReviewResult`. The orchestrator atomically applies every decision:
     - `approve` marks that Plan revision `approved` and starts a new implementation Attempt in the
       same workspace with the approved Plan as handoff;
     - `needs_rework` marks it `rejected`, keeps the work claimed in `In Progress`, and starts a
       fresh implementation Attempt with only the findings and factual handoff. The revised Plan is
       validated and reviewed again. After `agent.max_plan_revisions` (default 2) rejected revisions,
       route to `Human(human_review)`;
     - `needs_input` marks it `rejected`, stores the question, and parks the work as
       `AwaitingHuman` in `Human(needs_input)`. The answer seeds a new Plan revision; it does not
       convert the rejected revision into an approval.
   - If the issue itself is not implementable as specified (missing acceptance criteria,
     contradictory requirements), the correct plan-stage outcome is `needs_input` — the plan gate
     doubles as the issue-readiness check.
4. Implement in short sessions: `agent.max_turns` default 8, `agent.turn_timeout_ms` default
   900000 (15 min), token cap per Section 7. State lives in the workspace and the durable store,
   not in long threads. Continuation guidance is orchestrator-rendered and MUST contain: current
   plan state, last verification output, unmet acceptance criteria, remaining turn/token budget,
   and the instruction to submit a Plan revision when planned paths, verification, size, or risks
   change. It MUST NOT resend the original prompt.
5. **Reclassify and verify before accepting done.** Recompute class from the final diff and apply any
   newly required gates. A `completed` proposal requires the agent's verification evidence; absence
   is a protocol failure. The orchestrator then runs and records the independent Section 6.2
   verification. A non-passing Verification Record routes to rework.
6. After verification passes, the completed outcome requests branch publication and PR
   creation/update. The orchestrator
   commits the result, performs authorized actions through Section 16.2, stores the resulting links,
   and moves the issue to `Review`.

### 5.4 Outcome Routing

| Outcome | Orchestrator action |
|---|---|
| `completed` (implementation) | verify evidence + guards → `Review` |
| `plan_ready` | dispatch plan review |
| plan review `approve` / `needs_rework` / `needs_input` | apply the three atomic routes in Section 5.3 |
| `needs_rework` | stay/return to `In Progress`; findings attached to next attempt; bounded by `agent.max_rework_cycles` (default 2), then `Human(human_review)` |
| `blocked` | `Human(blocked)` with the named external blocker; claim → `AwaitingHuman` |
| `needs_input` | `Human(needs_input)`; question rendered per Section 11.2 |
| `no_progress` | retry once fresh; second time → `Human(no_progress)` |
| `budget_exhausted` | `Human(budget_exhausted)` with spend summary |
| `failed` | classify (Section 13) and retry only within budget |

Missing, malformed, or evidence-free role terminal results produce an orchestrator-authored
ExecutionFailure with class `agent_process`, never success.

A ReviewResult always creates its per-attempt Review Record and moves the Claim to `Ready`; no
lifecycle route is chosen until the complete required set can produce a ReviewSet. An
AdjudicationResult `resolve` applies only the named conflict dispositions and then recomputes that
ReviewSet; `needs_human` parks the work in the issue `Human(human_review)` lane or SystemJob `human`
stage with its question. A SynthesisResult `propose_changes` moves the synthesis SystemJob to
`review` after authorized branch/PR publication, `no_change` moves it directly to `done` with its
evidence, and `needs_input` parks it in `human` with its question. Each result, claim-mode change,
Plan/ReviewSet update, and internal SystemJob stage change is one atomic durable transaction.

An ExecutionFailure with `budget_exhausted` parks an issue in `Human(budget_exhausted)` or a SystemJob
in `budget_exhausted` pending an authorized budget action. An ExecutionFailure with `failed` routes by
Section 13 and its work reference.

For an implementation Attempt whose work reference is a repair SystemJob, the Section 5.4 statuses
map to SystemJob stages instead of tracker lanes: `completed → review`, `needs_rework → rework`, and
`blocked`/`needs_input`/`no_progress → human` with ParkedWork. No tracker transition is synthesized.

Every issue-lane transition is a SideEffectIntent. The orchestrator opens the corresponding
StageTransition only after a receipt confirms the tracker revision. On failure it retains the prior
confirmed lane, records the typed failure, and reconciles before retrying.

## 6. Workspaces and Verification

### 6.1 Layout and Safety Invariants

- Path: `<workspace.root>/<sanitized identifier>` (`[A-Za-z0-9._-]`, others → `_`).
- SystemJob path: `<workspace.root>/_system/<kind>-<sanitized short id>`.
- The agent subprocess `cwd` MUST be the workspace path.
- The workspace path MUST resolve (symlinks included) to a descendant of `workspace.root`;
  string-prefix checks are insufficient.
- Before any agent or hook runs, the runner MUST enforce a filesystem write boundary using a
  sandbox, mount namespace, dedicated account/ACL, or equivalent control. The process may write only
  beneath the fully resolved assigned workspace; its `HOME`, temporary directory, caches, and tool
  state MUST also be located there. The control MUST resolve every write target at operation time
  and deny absolute external paths, `..` traversal, bind/mount escapes, and symlinks whose target is
  outside the workspace. Setting `cwd` or relying on prompt instructions is not enforcement.
- One work-ref Claim owns one mutable workspace; unowned workspaces are quarantined at startup.
- Before the first agent starts, the Workspace Manager populates a checkout at the recorded base SHA
  through a trusted repository adapter or operator-managed local mirror. It records repository,
  base SHA, checkout method, and local branch. Agents may create local commits but cannot publish
  them; Section 16.2 publishes from the workspace after authorization.
- The runner MUST launch the agent in a process group (or equivalent) and, on cancellation,
  timeout, stall, or shutdown, terminate all descendants and verify exit before releasing the
  lease.
- Workspaces persist across attempts for the same work item; terminal issue and completed SystemJob
  workspaces are cleaned at startup and on reconciliation after durable history is committed.

### 6.2 Verification Loop (REQUIRED)

`workspace.verify_command` is a REQUIRED config value: the command that provides ground truth for
this repository (tests, typecheck, lint, build — repository's choice). Setting it to the literal
`none` is permitted only with `workspace.verify_none_reason` documented, and restricts all issues
to `supervised` merges.

The prompt MUST instruct agents to run it early and often. At the `completed` boundary, the
orchestrator MUST independently run the pinned command in the workspace against the proposed target
revision, using the scrubbed verifier environment, and commit a Verification Record. Agent-provided
verification evidence is useful context but cannot satisfy the guard by itself. Failure routes to
rework; runner/configuration failure routes by Section 13. The merge queue re-runs required CI checks
regardless.

### 6.3 Hooks

`after_create` (runs only after a new workspace is populated; fatal on failure), `before_run`
(fatal to the attempt), `after_run` (logged, ignored), `before_remove` (logged, ignored). Executed
with the workspace as `cwd` via a
**non-login** shell (`bash -c`) and the scrubbed environment of Section 15.2, bounded by
`hooks.timeout_ms` (default 60000).

## 7. Cost Control

Budgets are enforced, not observed. The per-attempt token cap is always enforced. Priced adapters
also enforce per-attempt, per-issue, and rolling fleet USD budgets; unpriced adapters enforce token
equivalents at issue and fleet scope.

### 7.1 Budget Scopes

- `budget.per_attempt_tokens` (default 400000): a hard cap for every Attempt, including Attempts for
  SystemJobs. The runner terminates the process tree at the cap. The orchestrator writes a
  `budget_exhausted` ExecutionFailure from the latest durable handoff and identifies itself, not the
  terminated agent, as the result author.
- `budget.per_attempt_usd` (default 5.00): a hard priced-adapter cap for every Attempt. Dispatch
  reserves against its attempt ledger; streaming usage is topped up only to this limit. Once
  observed usage reaches the cap, no further turn starts and the process tree is terminated with the
  same orchestrator-authored result. Delayed provider reporting may produce a recorded overrun but
  never authorizes another turn.
- `budget.per_issue_usd` (default 10.00): cumulative across all attempts and reviews for the
  issue. Exhaustion → `Human(budget_exhausted)`. Nothing dispatches for the issue until the
  operator raises its budget or resets it.
- `budget.rolling_24h_usd` (default 50.00): fleet-wide, rolling 24h. Exhaustion pauses new dispatch
  (running attempts finish), fires a notification, and resumes automatically when the window
  clears.
- `budget.per_issue_tokens` (default 2000000) and `budget.rolling_24h_tokens` (default 10000000):
  required enforcement scopes when `cost_usd` is unavailable. They have the same parking and pause
  behavior as their USD counterparts.

### 7.2 Accounting

Token accounting is a boundary contract, because budgets depend on it:

- Adapters emit `token_usage` events carrying **absolute session totals**
  (`input_tokens`, `output_tokens`, `total_tokens`) plus any priced categories required by the
  pinned price table (for example cached input). Delta-style provider payloads MUST be converted to
  absolute totals inside the adapter; the orchestrator never sees deltas.
- The orchestrator tracks the last reported totals per session and accumulates the difference,
  so repeated or replayed events never double-count.
- A generic `usage` map on other event types is informational only and MUST NOT feed totals.
- `cost_usd` is the sum of each absolute billable category multiplied by its rate in the pinned
  model/price-table version, with units normalized explicitly. It updates as events stream and is
  finalized at Attempt exit. Attempts that die without a final usage event keep their last
  accumulated value.

Per-issue cost is the sum over its attempts and MUST be answerable from the durable store with one
query. Per-issue tokens are the corresponding token sum. Rolling fleet usage and aggregates by
role, class, and profile are derived from the same records and SystemJobs.

### 7.3 Budget-Aware Routing

Before dispatch, the orchestrator reserves expected usage against every applicable ledger: attempt
for all work, issue for issue work, and rolling fleet for all work. A priced adapter reserves tokens
against the attempt token cap and USD against attempt, issue, and fleet ledgers; an unpriced adapter
reserves tokens against attempt, issue, and fleet ledgers. Expected tokens are the configured
profile estimate until `budget.history_min_samples` matching Attempts exist, then the higher of that
estimate and the nearest-rank 75th percentile over the most recent
`budget.history_window_samples` Attempts for the same role/profile. Before enough priced cost
history exists, expected USD is expected tokens at the highest applicable per-token rate in the
pinned price table; afterward it is also floored by the matching cost percentile. Fan-out reserves
the sum of all children. A reservation that does not fit routes an issue to
`Human(budget_exhausted)`, parks a SystemJob in `budget_exhausted`, or pauses fleet dispatch; it MUST
NOT start partially.

As usage streams, actual usage replaces the reservation. Before actual usage can consume the
remaining reservation, the orchestrator atomically requests a top-up; if no applicable ledger can
grant it, the runner starts no further turn and terminates the execution with `budget_exhausted`.
Unused reservation is released at Attempt exit. The hard per-attempt token and, when priced, USD
caps bound a single Attempt. Issue and rolling fleet limits are dispatch ceilings: running work may
consume its granted reservation. Any unavoidable overrun from delayed provider reporting is recorded
as a budget-overrun event, blocks further dispatch in that scope, and is never hidden or
retroactively deleted. The UI
MUST distinguish limit, reserved, consumed, overrun, and remaining values. Budget changes and resets
are durable OperatorActions and never delete usage history.

Remaining budget is also a routing input: an escalation or specialist fan-out whose reservation
exceeds remaining budget does not run. Escalations never lower deterministic risk floors; budgets
never raise autonomy.

## 8. Compute Routing

Logical profiles `economy`, `standard`, `deep` map to provider `model` + `reasoning_effort` in the
versioned agent adapter. Workflow policy names only logical profiles and role/class defaults; it
MUST NOT embed provider model slugs.

- Each attempt pins one profile at dispatch; the model never changes inside a thread.
- Attempt-role defaults: `plan_review`: economy; `implementation`: by change class (Section 4);
  `integrative_review`: standard; `specialist_review` and `adjudication`: deep. The synthesis
  SystemJob uses `deep`.
- Deterministic risk-floor rules raise the floor; a heuristic or model classifier MAY raise,
  MUST NOT lower.
- At most `agent.max_escalations` (default 1) per work item: a fresh Attempt on a stronger profile,
  seeded only with the structured factual handoff. Escalate when an attempt exposes new risk,
  contradicts evidence, or repeats a failure — and only if budget allows (Section 7.3).
- Selected profile, resolved model, effort, and triggering rule ids are pinned on the attempt and
  visible in events.

Each `compute.risk_floor_rules` entry is `{id, roles[], when, minimum_profile}`. `when` contains only
deterministic predicates over labels, proposed/changed path globs, diff size, acceptance-criteria
presence, dependency facts, and configured change facts. Unknown predicates are validation errors.
Rules are evaluated in order and the highest matching floor wins; order breaks ties only for
recorded routing reasons.

The built-in ids are `risk.security_auth`, `risk.migration_data`, `risk.concurrency`,
`risk.public_api`, `risk.cross_package_architecture`, and `risk.ambiguous_criteria`; each maps its
corresponding Section 4 fact to `deep`. Configuration MAY add rules but MUST NOT lower the class and
role defaults in this section. Built-in risk rules target the `implementation` role; plan review
remains `economy`, while specialist/adjudication roles already have a `deep` default.

## 9. Review

### 9.1 Pipeline

1. Deterministic checks first: CI status, diff scope vs. plan, passing orchestrator Verification
   Record present,
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
5. After the complete required reviewer set finishes, the Review Coordinator atomically commits the
   Section 3.6 ReviewSet. Its aggregate decision routes once: approve (→ merge queue), needs_rework
   (→ `In Progress` with findings), needs_human (→ `Human(human_review)`), blocked (→
   `Human(blocked)`). A partial reviewer set can never produce aggregate approval.

All review output is written as durable Review Records and one aggregate ReviewSet (Section 3.6).
The merge gate reads only the ReviewSet, pinned to the reviewed SHA, and the records it names. A SHA
change invalidates prior approvals.

Each `review.specialists` entry is `{name, trigger_rules[], concerns[], required_evidence[],
excluded_context[], profile}`. Names are unique; profiles resolve through the adapter; trigger rules
use the same deterministic predicate vocabulary as Section 8. A matching specialist receives only
its declared evidence plus the common immutable review inputs. Invalid entries fail configuration.

### 9.2 Check, Review, and Thread Gate

Required checks are the union of `review.required_checks` and checks reported as required by the
repository's protection rules. A configured check missing from the snapshot is pending, not
successful. Every required check MUST target the current head SHA and have a conclusion in
`review.accepted_check_conclusions` (default `success`, `neutral`, `skipped`). Pending, stale,
cancelled, timed-out, action-required, or missing checks deny the gate with a typed reason.

The pull request MUST be open, non-draft, and mergeable. Missing/closed PRs and incomplete snapshots
deny with a typed artifact reason; transient mergeability calculation and pending checks wait only
within the configured settle timeout.

Each snapshot fetch is bounded by `review.snapshot_timeout_ms`. Fetch/auth/pagination failure never
passes the gate; it retains the last confirmed stage and routes according to Section 13.

An unresolved, non-outdated review thread blocks the gate. A changes-requested review blocks until
the same reviewer dismisses or supersedes it, or an operator with `merge_queue.write` records an
audited override.
Human merge approval counts only when submitted by an operator whose configured `tracker_login` has
`merge_queue.write`, targets the current head SHA, and has not been superseded. Model Review Records
never impersonate Git-hosting reviews.

### 9.3 Review Economics

Blocking findings must carry behavior + evidence + disposition; unsupported stylistic preference is
non-blocking by definition. Review spend is recorded like any attempt and reported per issue and
per class; there is no fixed percentage target — the calibration signal is the escaped-defect rate
(Section 14.2) versus review spend, examined at synthesis time.

## 10. Git, PRs, and the Merge Queue

### 10.1 Branch and PR Contract

- One branch per issue: `symphony/<sanitized-identifier>`, created from the default branch.
- One branch per SystemJob PR: `symphony/system-<kind>-<short-id>`.
- Repair cycles use `<primary-branch>-repair-<cycle>` from the then-current default branch.
- At most one open PR per work item at a time, created or updated by the orchestrator through Section
  16.2 after an authorized result; an issue PR body links the issue. A repair PR begins a new work
  cycle after the prior PR is merged or closed. Force-pushes are permitted only to the work item's
  own branch.
- The PR description carries the plan summary and verification evidence (projection of durable
  records; human-readable only).

### 10.2 Human-Readable Projection

The workpad of v2 is reduced to a projection: the orchestrator MAY maintain one issue comment
summarizing plan, status, spend, guard results, and links. It is written by the orchestrator from
durable state, never parsed as an input to any decision.

### 10.3 Merge Queue

Merges are serialized per repository: at most one repository mutation may be in the landing or
post-merge verification phase at a time. Independent repository queues MAY progress concurrently.

1. Eligibility: aggregate ReviewSet approval for the current head SHA, the Section 9.2 gate allows,
   autonomy policy permits (Section 11.1) or an authorized operator approved, and the side-effect
   intent targets the current head and observed base SHA.
2. If the base branch advanced: update/rebase the branch and re-run required checks. Compute a
   normalized patch identity from the ordered file modes, paths, and content changes between base
   and head, excluding commit metadata. If it equals the identity reviewed previously, Symphony MAY
   carry forward only its internal review conclusion: it MUST write an allowing carry-forward Guard
   Decision and a new ReviewSet pinned to the updated head/base, linked to the prior ReviewSet and its
   named Review Records. The new set records the current passing Verification Record and current
   guards. CI and human review requirements still target the new head. A changed identity requires
   fresh integrative review.
   The orchestrator also reclassifies the changed diff and applies any higher risk floor.
3. Merge via the repository's landing procedure; watch required post-merge/deploy checks to a
   terminal state; then move an issue to `Done` or a SystemJob to `done`.
4. A pre-merge failure routes an issue to `In Progress` or a SystemJob to `rework`, with evidence,
   and pauses that repository's current queue entry until repaired or skipped by an operator.
5. A post-merge/deploy failure creates a new repair cycle, branch, and PR through Section 16.2,
   links the failed merge revision, and records an escaped defect when the failure indicates shipped
   or default-branch breakage. The original issue returns to `In Progress`; a SystemJob enters
   `failed` and links a repair SystemJob. The merged branch is never treated as an open rework branch.
   Other repository queues continue.

A repair SystemJob follows the Section 5.3 plan, classification, implementation, independent
verification, review, and budget contracts without tracker-lane mutations. Its provisional class is
at least `standard`; security, data, migration, concurrency, or public-API failures make it
`high_risk`.

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

Operator approval is given on the PR by an authorized login or through the authenticated UI/API;
the orchestrator detects or records it at reconciliation.

### 11.2 Structured Questions

`needs_input` renders the terminal result's `question` into the UI and, for issue work, one issue
comment:

```
**Symphony needs a decision** (issue parked in Human)
<question text>
1. <option A> (default)
2. <option B>
Reply with a number or free text. First reply from an authorized operator is consumed.
```

Authorized operators are `human.operators` (REQUIRED records with stable `id`, optional
`tracker_login`, Control API `auth_subject`, and `capabilities`). The first answer submitted by a
configured tracker login or API identity whose operator has `question.answer` wins through an atomic
expected-version update. It is stored durably, echoed into the next attempt's context, and the issue
or SystemJob returns to its origin stage. Human-parked work is reconciled every tick;
`human.reminder_hours` (default 24) re-notifies once.

### 11.3 Notifications

`notify.command` (shell) and/or `notify.webhook_url`. Fired on: entry to `Human` (any reason),
rolling fleet-budget exhaustion, autonomy demotion, merge-queue pause, synthesis PR opened, and
service startup validation failure. Payload: work reference and URL when applicable, reason,
one-line summary, and spend so far.
Each notification uses a SideEffectIntent/Receipt and idempotency key; delivery failure is visible in
the UI and follows infrastructure retry policy without duplicating a confirmed delivery.
The notification adapter accepts the common Section 3.14 MutationAuthorization and rejects any
delivery whose fleet/work scope, configuration snapshot, target, or action does not match it.

### 11.4 Operator Controls

The UI and API are the required operator channel for budget changes/resets, autonomy promotion or
demotion, privileged configuration acknowledgment, durable configuration overrides, merge-queue
retry/skip, synthesis dispatch, retention policy, and manual refresh. Each action requires an
authorized capability, expected target version, idempotency key, and durable OperatorAction. Direct
database writes are non-conforming.

Required capability identifiers are `operator.read`, `question.answer`, `config.write`,
`agent.approve`, `config.ack`, `budget.write`, `autonomy.write`, `merge_queue.write`,
`synthesis.write`, and `retention.write`. An implementation MAY add capabilities but MUST NOT
collapse all mutations into read access. The bootstrap administrator receives all required
capabilities until changed through an acknowledged operator configuration.

## 12. Learning Loop

### 12.1 Lesson Capture

The orchestrator writes Lessons (Section 3.8) automatically for: guard denials, rework cycles
(with the triggering findings), blocking review findings, escaped defects, plan rejections,
repeated tool failures, budget exhaustions, and every `confusions` entry from outcomes. No agent
cooperation is required beyond the outcome contract.

### 12.2 Synthesis

After every `learning.interval_issues` (default 25) completed issues — or on an authenticated
operator action — the orchestrator queues one synthesis SystemJob (deep profile). Its Attempts use
the global concurrency pool and rolling fleet budget. Inputs:
lessons since the last synthesis, current prompt and rules with citation counts, and per-class
quality/cost metrics. Its typed SynthesisResult either proposes a PR editing the workflow prompt's
rules block and, where justified, repo docs; records an evidence-backed `no_change`; or asks a
structured operator question. A proposal includes a summary of rule additions/removals with cited
lesson ids.

The orchestrator creates the SystemJob and dispatches one `synthesis` Attempt. The SystemJob enters
its own `review` then `merge` status and uses the same review and
repository merge gates as issue work. It is always `supervised`; it does not create or move a
tracker issue. Self-improvement is gated exactly like code.

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
  honoring provider retry-after. It does not consume `agent.max_failure_retries`. Persistent
  infrastructure failure (>1h) fires a notification.
- `agent_process` — crash, protocol violation, timeout, stall, malformed terminal result. Retried within
  `agent.max_failure_retries` (default 2) per work-item cycle.
- `configuration` / `auth` — not retryable. A shared adapter, credential, or configuration failure
  pauses dispatch for its affected scope; an issue-specific permission failure parks that issue in
  `Human(blocked)`. The record names the observable recovery fact. Repeating a non-retryable failure
  without new evidence is prohibited.
- `policy` — denied side effect, unsafe path, injection boundary. Not automatically retryable;
  always produces a lesson.
- `task` — deterministic test failures, unreconcilable criteria. Not a retry; routes through
  outcomes (`needs_rework` / `needs_input` / `blocked`).

Stall detection: no adapter event for `agent.stall_timeout_ms` (default 300000) → kill and retry.
Restart recovery: reload leases/attempts before dispatch; close attempts interrupted without a
durable terminal result as `agent_process`; reconcile side-effect intents by idempotency key; compare
tracker, store, and workspace ownership before any re-dispatch; never assume an old process
survived.

Every external mutation carries an idempotency key (work reference, attempt/SystemJob, action,
target revision) and is
committed as an intent before it is applied. Persistence failure stops new dispatch and external
mutations immediately. Existing workers MUST be stopped if the service can no longer renew leases,
record token/cost usage, or commit their terminal result safely.

## 14. Observability and Quality Measurement

### 14.1 Required Surfaces

- **Structured durable logs** with `service_run_id` and, when applicable, `work_ref`, issue
  identifier, `attempt_id`, `session_id`, and stage transition. Startup, validation, dispatch, agent
  activity, commands, tool actions, verification, review, merge, and failure records MUST be visible
  in the UI without a debugger.
- **Event records** (append-only table, exportable as JSONL): lane transitions, dispatches with
  routing reasons, terminal results, guard decisions, review decisions, merges, budget events,
  autonomy changes, configuration changes, and syntheses. Every event carries `event_name`,
  `result`, `reason_code`, `timestamp`, and the identifiers applicable to that event. Fleet events
  may omit `work_ref`; work-scoped events require it; attempt events require `attempt_id` and
  `compute_profile`; issue implementation events require `change_class`; `cost_usd` is null for
  unpriced work. Budget events require scope, limit, reserved, consumed, overrun, and remaining.
  Configuration and operator events require actor, target, and version. Events MUST NOT contain
  prompts, diffs, or secrets.
- **Cost queries**: per-issue, per-class, per-role, SystemJob, and rolling fleet usage answerable
  from the store.

Attempt/SystemJob totals, UsageSamples, ServiceRuns, StageTransitions, terminal results, evidence,
links, events, logs, review records, and OperatorActions are durably retained indefinitely by
default. Section 14.5 governs explicit retention and deletion.

### 14.2 Quality Metrics (the other Pareto axis)

An **escaped defect** is: a revert of a Symphony merge; a post-merge/deploy failure attributable to
that merge; a subsequent fix PR linked to the same issue or touching the same files within
`quality.escape_window_days` (default 14) and confirmed by an authorized operator or sampled audit;
or a blocking finding from a sampled audit (Section 4).

A sampled audit creates a reproducible read-only checkout of the recorded merge SHA and base SHA,
runs the required deterministic checks, and dispatches a deep review with the original criteria and
diff. Its findings, usage, cost, and target revisions are durable even though the issue is terminal
and its mutable workspace has been cleaned. A blocking finding creates a lesson, demotes autonomy,
and opens or links a repair work item; it never silently reopens a cleaned workspace.

Tracked per change class and compute route: escape rate, rework cycles per accepted issue,
plan-rejection rate, cost per accepted issue, and review spend per accepted issue. These numbers
drive autonomy promotion evidence, risk-floor tuning, and synthesis — they are the point of the
whole exercise: cost per accepted issue on one axis, escape rate on the other.

### 14.3 Required Operator UI

A conforming implementation MUST ship a working browser UI. Shipping only the API is
non-conforming. The UI reads the required Control API; it MUST NOT query SQLite directly or derive
decision state from tracker comments or humanized log strings.

Required surfaces:

1. **Operations dashboard** — current issue count by lane; running attempts with current role/stage;
   retry due times; parked reasons and waiting duration; SystemJob status; merge queues by
   repository; current USD and
   token limits at attempt/issue/fleet scope, reservations, consumption, overrun, and remaining
   budget; cumulative token/cost/time totals;
   latest failures and notifications; direct links to every tracked issue and generated PR.
2. **Issue and run history** — issue metadata and links; a StageTransition timeline with duration in
   each stage; all issue attempts/reviews and any SystemJobs whose evidence references the issue,
   terminal results, evidence,
   verification, findings, side effects, configuration snapshots, token/cost/time totals and usage
   history; logs and normalized agent actions grouped by stage; previous completed runs and service
   restarts. Logs MUST support pagination, filtering, and live updates after the durable write.
3. **Settings and controls** — every configurable key's effective value, source (`default`,
   `workflow`, or `operator_override`), version, reload category, acknowledgment and restart state;
   create/update/clear controls for every runtime-overridable key; bootstrap-only keys shown read-only
   with the reason; budget change/reset; autonomy controls; privileged change acknowledgment;
   pending agent approvals; merge-queue retry/skip; synthesis trigger; retention policy; operator
   audit log.

The UI MUST identify stale data and API errors visibly. A failed mutation MUST leave the submitted
value and structured error visible; the UI MUST NOT display an uncommitted optimistic value as
effective configuration.

### 14.4 Required Control API

The authenticated API MUST provide, at minimum:

- state, budget, quality, notification, and repository-queue reads;
- paginated issue, attempt, SystemJob, ServiceRun, StageTransition, event, log, usage, ReviewRecord,
  ReviewSet, evidence, mutation-authorization, side-effect, RepositoryLink,
  configuration-snapshot, and OperatorAction reads;
- effective configuration and source metadata reads;
- configuration override create/update/clear and privileged acknowledgment;
- operator-question answer and agent-approval decision; budget change/reset; autonomy change; queue
  retry/skip; synthesis dispatch; retention update; and immediate refresh operations.

Every read requires `operator.read`; mutation endpoints require their Section 11.4 capability in
addition.

All mutations require an authenticated operator, an explicit capability, `expected_version`, and
`idempotency_key`. Repeating a key in the same actor/endpoint/target scope with the same request hash
returns the original result; a different payload returns `409 idempotency_conflict`. A version
mismatch returns `409` without changing target state but is still audited. Browser mutations require
same-origin enforcement and a CSRF defense bound to the authenticated session. Remote access
requires TLS; the default bind is loopback. Authentication
cookies MUST be `Secure` when TLS is used, `HttpOnly`, and `SameSite=Lax` or stricter.

Issue text, logs, commands, tool output, comments, and URLs are untrusted UI data. The UI MUST escape
them by default, sanitize any explicitly supported rich text, reject unsafe URL schemes, and ship a
Content Security Policy that prevents inline script execution from displayed content.

Errors use `{ "error": { "code": "...", "message": "...", "details": {...},
"current_version": "..." } }`. Authorization failures return `403`; unauthenticated requests
return `401`; invalid values return `422`. Secrets are never returned. Every accepted or rejected
authenticated mutation creates an OperatorAction, including actor, capability, target version,
reason, and result. Unauthenticated attempts create a rate-limited security LogRecord without
persisting supplied credentials.

### 14.5 Durable History and Retention

The default retention value is `null`, meaning indefinite. Completed issues, previous attempts,
previous ServiceRuns, stage durations, logs, events, token and cost history, evidence, links, and
operator actions remain queryable and visible in the UI after completion and restart.

An authorized operator MAY set a finite retention policy or request deletion through the API. The
change and each deletion are audited. Deletion MUST NOT remove active-work records, unresolved
side-effect evidence, records under an operator/legal hold, or the aggregate usage/cost/quality data
needed to explain current budgets and autonomy. When detail is deleted, the UI MUST show a durable
tombstone containing scope, time range, actor, policy version, deletion time, and retained aggregate
totals; it MUST NOT present missing history as if no activity occurred.

## 15. Security

### 15.1 Trust Boundaries

Issue text, PR comments, repository contents, tool output, and fetched content are untrusted input.
Policy lives in the orchestrator and effective configuration, never delegated to those inputs.
Agents hold no tracker, repository-hosting, notification, operator-control, or control-plane
credentials; all such mutations flow through typed adapters with authority checks, revision
pinning, idempotency, and audit. A deployment MUST prevent agents from recovering host credentials
through inherited environment variables, credential files under `HOME`, sockets, or mounted paths.
Broad passthrough tools (raw GraphQL execution in-session) are not part of this specification.

### 15.2 Secrets and Environment

- Config secret values MUST use `$VAR` indirection. Literal tokens in `WORKFLOW.md` are a
  validation error.
- Agent and hook processes receive a scrubbed environment: `env.allowlist` plus a minimal
  PATH/locale baseline and an isolated credential-free `HOME` created for that execution context.
  The orchestrator's environment and host HOME are never inherited wholesale.
- Secrets are resolved at the adapter boundary, never persisted in snapshots, prompts, handoffs,
  events, or logs; tool results are filtered for credential patterns before entering model context
  or durable records.

### 15.3 Config-Change Acknowledgment

`WORKFLOW.md` is repo-owned and agents modify the repo. Any candidate change that executes code,
widens authority, exposes the service, changes credentials, or changes who may operate it requires
explicit acknowledgment through the authenticated UI/API. This includes `hooks.*`,
`agent.command`, `workspace.verify_command`, `notify.command`, `notify.webhook_url`,
`env.allowlist`, approval/sandbox posture, `human.operators`, tracker/repository scope, authentication
settings, non-loopback binding, workspace/database roots, and equivalent adapter settings.
Keys marked `file-ack+` also treat repository-originated changes as pending because they can weaken
cost, routing, verification, or quality controls; the same typed value set by an authorized operator
override does not require a redundant second confirmation.

Acknowledgment is a separate OperatorAction bound to the candidate config hash and expected
version. A confirmation click that does not name that candidate is insufficient. Until acknowledged,
the last known good effective value remains active and the UI shows the candidate as pending.
Invalid candidates are never acknowledgeable. The reload category controls when an acknowledged
value applies. This closes the loop where merged agent output becomes trusted shell or authority.

First startup has no authenticated operator or last known good configuration. Bootstrap is permitted
only when the post-migration database is **pristine**: every domain table other than schema-migration
metadata is empty, with no ServiceRun, operator, claim, attempt, live session, intent, receipt,
history, or configuration record. That store enters a narrow pre-auth bootstrap state before normal
configuration validation: the service binds only to loopback, keeps orchestration and every external
mutation disabled, and validates all configuration except the non-empty operator/auth-subject
mapping and acknowledgments that require that first operator. The configured authentication adapter
itself must still be structurally valid.

An operator-empty but non-pristine database is corruption/recovery, never first startup. Bootstrap
is prohibited. Before failing closed, the service loads recorded live sessions and intents,
terminates and verifies every owned process, and queries providers by idempotency key to record any
already-applied receipt; it MUST NOT issue a new external mutation or dispatch. It then records
`operator_store_missing_nonpristine` and exits, requiring restoration of a known-good database with
its operator/auth records. It MUST NOT create a replacement administrator in that store.

Bootstrap requires a single-use credential supplied through a trusted startup argument or host
environment (never `WORKFLOW.md`), displays the complete privileged-candidate hash on the trusted
local console, and requires both that credential and explicit local hash confirmation. One SQLite
transaction creates the initial administrator, its authentication mapping, the acknowledged initial
configuration snapshot, and the bootstrap OperatorAction. Failure rolls back the entire transaction
and leaves the service in loopback-only bootstrap state. The service then reruns full ordinary
validation; only success permanently disables bootstrap and enables the authenticated UI/API and
orchestration. It MUST NOT expose an unauthenticated remote setup page or reuse the bootstrap
credential. After bootstrap, the UI/API is the only conforming acknowledgment channel.

### 15.4 Sandboxing

The agent adapter's approval/sandbox settings are configuration, and each deployment MUST document
its posture. Approval requests and user-input signals from the agent protocol MUST NOT stall a run
indefinitely: satisfy, surface, or fail them per documented policy. Independently of those
provider-specific settings, every deployment MUST enforce the Section 6.1 write boundary for agent
and hook processes. OS/container isolation, dedicated users, restricted workspace volumes, and
network egress controls remain recommended defense in depth beyond that mandatory boundary.

When policy surfaces an approval request, the orchestrator stores it durably, parks the execution
in the issue `Human(agent_approval)` lane or SystemJob `human` stage without consuming an active
agent slot where the protocol permits, and exposes it through UI/API. Only `agent.approve` may
resolve it; the decision, actor, scope, and expiry are audited, then work returns to its origin stage.
Timeout or unsupported parking produces a typed failure instead of an indefinite wait.

### 15.5 Operator Authentication

The configured authentication adapter MUST map a verified credential to an immutable
`auth_subject`, which must match one `human.operators` record. Capabilities come from that effective
operator record, not from client-supplied claims. Supported mechanisms are implementation-defined
but MUST document session lifetime, logout/revocation, credential storage, and subject mapping.

Local credentials are salted password hashes or stronger verifier records, never plaintext. OIDC
validates issuer, audience, signature, expiry, and nonce. Trusted-proxy identity headers are accepted
only from a configured authenticated proxy path and stripped from direct requests. Credentials and
session tokens never appear in URLs, logs, events, configuration snapshots, or API responses.
When an effective operator record or capability changes, the service MUST re-evaluate active
sessions before their next request and revoke access that is no longer granted.

### 15.6 First-Run Setup

An implementation SHOULD ship a guided command-line setup that prepares a deployment before the
service first starts. Setup is RECOMMENDED tooling, not a Core requirement; when provided it MUST
follow this contract.

Setup runs before bootstrap (Section 15.3), so no authenticated operator or durable state exists
yet. Its only outputs are `WORKFLOW.md`, host-environment values, and operator-confirmed
tracker-side changes made with the operator's own interactively supplied credentials. It MUST NOT
create durable-store records (preserving the pristine-database bootstrap invariant), MUST NOT bind
a network listener, and MUST NOT store its own state outside the outputs above.

The guided flow covers, in order:

1. **Tracker selection** — choose `tracker.kind` and its identifying configuration
   (Section 18.1 `tracker.*` keys).
2. **Credentials** — verify host authentication for the selected tracker and agent adapter using
   each provider's native flow (for the GitHub reference profile, `gh` device-flow login; for
   API-key trackers, an interactive prompt). Secret values are written only to the host
   environment or an operator-chosen environment file and referenced from configuration as `$VAR`
   (Section 15.2). Setup MUST NOT write a literal credential into `WORKFLOW.md`.
3. **Project selection or creation** — list existing candidate projects/boards to choose from, or
   create a new one through the Section 16.1 schema operation.
4. **Schema check and remediation** — verify the configured status field exposes every
   Section 5.1 lane, the priority field exists, and write authority works: the same checks as
   Section 18.2 validation. Each missing item is offered as an explicit fix; setup MUST NOT
   mutate the tracker without a per-change operator confirmation.
5. **Workflow generation** — write `WORKFLOW.md` with the selected tracker keys, prompting for
   required values that have no default (at minimum `workspace.verify_command`) and leaving
   documented defaults for everything else.
6. **Validation and handoff** — run the full Section 18.2 startup validation and report the
   result. On success, direct the operator to start the service, which enters bootstrap.

Setup MUST be idempotent: re-running it detects already-completed steps (valid credentials, an
existing conforming project, a parseable `WORKFLOW.md`) and prompts only for the gaps, so an
interrupted setup is resumed by running it again.

After bootstrap, the authenticated UI and API are the channel for runtime settings (Section 18.3);
setup exists for the identity-defining and secret-bearing values the UI intentionally cannot
manage: bootstrap keys, credential material, and tracker identity. Post-setup schema drift is
surfaced by per-tick validation (Section 18.2) in logs, events, and the UI; the remedy is a UI
override for runtime keys, or re-running setup for identity and credential keys.

## 16. Tracker and Repository-Hosting Adapter Contracts

### 16.1 Tracker Adapter

Required operations: `fetch_candidates()`, `fetch_states_by_ids(ids)`,
`fetch_issues_by_states(states)` (startup cleanup), `update_issue_lane(id, lane, reason)`,
`create_or_update_comment(id, marker, body)` (projection + questions),
`fetch_comments_since(id, cursor)` (answers), and cursor-based pagination for every list operation.
The adapter MUST detect an incomplete page (missing cursor while more results are reported) and fail
the operation rather than silently treating partial data as complete.

Adapter errors follow Section 13 (`infrastructure` unless clearly `auth`/`configuration`).
Candidate-fetch failure skips a tick; state-refresh failure keeps workers running.
Every mutating operation accepts the common Section 3.14 MutationAuthorization and MUST reject a
missing envelope, tracker-scope/actor/configuration mismatch, or state revision that differs from
the authorization's observed tracker snapshot. Provider request ids and resulting tracker revisions
are returned for the SideEffectReceipt.

**GitHub reference profile**: Issues + Projects v2; the Project single-select `Status` field is the
lane source of truth (lane names of Section 5.1 as options); `Priority` field for ordering; native
`blockedBy` for dependencies; `gh`/App auth (never tokens in config); one repository per workflow
unless multi-repo is explicitly supported. Other trackers (e.g., Linear) implement the same
contract; normalization per Section 3.1 (labels lowercased, ISO-8601 timestamps, blockers with
states).

Acceptance criteria are normalized only from structured tracker fields or checklist items under the
configured `tracker.acceptance_criteria_heading`; adapters MUST NOT invent them from prose. Missing
criteria produce an empty list and route through the plan-stage readiness rule.

`ensure_project_schema(project, status_field, lanes, priority_field)` is an OPTIONAL operation that
creates or repairs the tracker project so the configured status field exposes every Section 5.1
lane, the priority field exists, and write authority is confirmed. It exists for Section 15.6
first-run setup, runs with the operator's interactive credentials and per-change confirmation, and
takes no MutationAuthorization because it precedes the durable store; the running service MUST NOT
invoke it. An implementation advertising it declares Extension Conformance (Section 19.1) and MUST
test idempotent re-runs and partial-schema repair.

### 16.2 Repository-Hosting Adapter

Required operations:

- `publish_branch(work_ref, workspace, expected_base_sha)`
- `ensure_pull_request(work_ref, head_sha, base_ref, body_projection)`
- `fetch_pull_request_snapshot(work_ref)`
- `update_branch(work_ref, expected_head_sha, expected_base_sha)`
- `merge_pull_request(work_ref, expected_head_sha, landing_policy)`
- `fetch_post_merge_status(repository, merge_sha)`
- `create_repair_pull_request(work_ref, failed_merge_sha, evidence)`

`fetch_pull_request_snapshot(work_ref)` returns:

- `pr_number`, `pr_url`, `pr_state` (`open` | `closed` | `merged`), `is_draft`
- `head_sha`, `base_ref`, `observed_base_sha`, `mergeable`
- `required_check_source` (`configured` | `protection` | `union`)
- `checks[]`: `{name, target_sha, status, conclusion, url, required_source}`
- `review_decision` (`approved` | `changes_requested` | `none`)
- `reviews[]`: `{author, state, commit_sha, submitted_at}`
- `unresolved_threads[]`: `{id, author, url, commit_sha, is_outdated}`
- `post_merge_checks[]`: `{name, target_sha, status, conclusion, url}` when a merge SHA exists

The gate consumes only these normalized fields. An adapter MUST return complete review/check/thread
data or fail the snapshot; partial pagination MUST NOT appear as an empty or successful result.

Mutating calls accept the common Section 3.14 MutationAuthorization. The adapter MUST reject a
missing envelope, actor/role/configuration/repository-scope mismatch, or stale revision. It MUST
expose provider request identifiers and result revisions for the SideEffectReceipt. Agent and
reviewer processes MUST NOT receive the adapter's credentials.

The adapter owns provider-specific Git hosting details. The orchestrator owns policy: whether a
branch may be force-updated, which checks and reviews are required, whether approval may carry
forward, and whether a merge is authorized.

## 17. Agent Adapter Contract

Each provider integration is a versioned adapter that publishes: supported protocol range, price
table per model, profile→(model, effort) mapping, and normalized event mapping. The adapter MUST:

- Launch the subprocess in the workspace with scrubbed env; speak the provider protocol over its
  transport; verify protocol/capability compatibility **before** an Attempt is charged.
- Stream normalized events (`session_started`, `turn_completed`, `turn_failed`, token usage,
  agent actions, rate limits) through a bounded channel with backpressure or fail-fast overflow.
- Enforce read, turn, and token limits; expose one schema-constrained terminal-result channel whose
  schema matches the Attempt role. If a session ends without a result, the adapter MAY attempt one
  minimal elicitation turn on the Attempt's pinned profile in the same thread. Alternatively the
  orchestrator MAY create a separately charged salvage Attempt. It MUST NOT change model or profile
  inside an Attempt or thread.
- Terminate the full process tree and confirm exit on any end state.

Implementation roles also receive a schema-constrained `submit_plan` tool for Section 3.16. External
actions remain requests in the terminal result; agent tools MUST NOT directly execute tracker or
repository-hosting mutations.

Before charging an Attempt, the runtime resolves every `agent.required_skills` name in
documented repo-local and agent-home skill roots visible to that worker, records the resolved path
and content hash in the config snapshot, and verifies the adapter can expose it to the session. A
missing skill blocks dispatch with `configuration.missing_required_skill`; mentioning a skill only
in the prompt does not satisfy preflight.

The normalized upstream event set and error mapping every adapter targets are defined in
Appendix B alongside the Codex reference profile; alternative adapters map their protocol onto the
same enums so the orchestrator is provider-blind.

## 18. Configuration and WORKFLOW.md

One repo-owned file: YAML front matter (config) + Markdown body (the implementation prompt
template, rendered strictly — unknown variables/filters fail — with `work_ref`, `issue` or
`system_job`, `attempt`, `change_class`, `plan`, and `rules` available). The synthesized rules block
(Section 12) lives in the body between `<!-- rules:start -->` and `<!-- rules:end -->` markers.

The front matter is machine-readable YAML; Markdown is used only for the prompt body. This keeps the
versioned baseline and prompt in one reviewable artifact. UI edits create Section 18.3 overrides;
the UI MUST NOT rewrite or commit `WORKFLOW.md` implicitly.

Workflow path precedence is the trusted startup `workflow.path`, then `WORKFLOW.md` in the process
working directory. If the file starts with `---`, parse through the next `---` as YAML and require a
map; the trimmed remainder is the prompt body. Without front matter, config is empty and the whole
trimmed file is the body. Missing files, unterminated/invalid YAML, non-map front matter, empty prompt
body, and template parse errors fail startup. The service MUST detect file changes. An invalid reload
keeps the last known good file/config/prompt and records the error in logs, events, and UI.

### 18.1 Configuration Reference

This table is the configuration contract. Reload categories: **hot** (live scheduler, next tick),
**attempt** (new attempts/SystemJobs), and **restart** (pending until restart; never partially
applied). **bootstrap** comes only from the trusted startup boundary, is resolved before its first
use (`persistence.database_path` before the store opens), is read-only in the UI, and cannot be a
durable override. **ack+** is a modifier requiring Section 15.3 acknowledgment before the category
applies regardless of source. **file-ack+** requires acknowledgment for a `WORKFLOW.md`
candidate; an authenticated, authorized UI override is itself sufficient approval and applies at the
named reload boundary.

Bootstrap values come only from trusted process arguments or host environment, never from
repository-owned `WORKFLOW.md`. A bootstrap key found in front matter or an override request is a
validation error. The UI displays its redacted effective value and trusted source read-only.

| Key | Type | Default | Reload |
|---|---|---|---|
| `workflow.path` | path | `<process-cwd>/WORKFLOW.md` | bootstrap |
| `tracker.kind` | string | (required) | ack+restart |
| `tracker.owner` | string | (required for github) | ack+restart |
| `tracker.project_number` | integer | (required for github) | ack+restart |
| `tracker.repo_owner` | string | (required for github) | ack+restart |
| `tracker.repo_name` | string | (required for github) | ack+restart |
| `tracker.status_field` | string | `"Status"` | ack+hot |
| `tracker.priority_field` | string | `"Priority"` | hot |
| `tracker.priority_order` | list of strings | `["P0", "Urgent", "Critical", "P1", "High", "P2", "Medium", "P3", "Low"]` | hot |
| `tracker.acceptance_criteria_heading` | string | `"Acceptance Criteria"` | ack+hot |
| `tracker.assignee` | string or null | `null` | ack+hot |
| `tracker.required_labels` | list of strings | `[]` | ack+hot |
| `polling.interval_ms` | integer | `30000` | hot |
| `workspace.root` | path | `<system-temp>/symphony_workspaces` | ack+restart |
| `workspace.verify_command` | string | (required; literal `none` permitted) | ack+attempt |
| `workspace.verify_none_reason` | string | `null` (required if `none`) | attempt |
| `hooks.after_create` | script | `null` | ack+attempt |
| `hooks.before_run` | script | `null` | ack+attempt |
| `hooks.after_run` | script | `null` | ack+attempt |
| `hooks.before_remove` | script | `null` | ack+attempt |
| `hooks.timeout_ms` | integer | `60000` | attempt |
| `agent.command` | string | `"codex app-server"` | ack+attempt |
| `agent.read_timeout_ms` | integer | `5000` | attempt |
| `agent.max_concurrent` | integer | `4` | file-ack+hot |
| `agent.max_turns` | integer | `8` | file-ack+attempt |
| `agent.turn_timeout_ms` | integer | `900000` | file-ack+attempt |
| `agent.stall_timeout_ms` | integer | `300000` (`<=0` disables) | file-ack+hot |
| `agent.max_failure_retries` | integer | `2` | file-ack+attempt |
| `agent.max_rework_cycles` | integer | `2` | file-ack+attempt |
| `agent.max_plan_revisions` | integer | `2` | file-ack+attempt |
| `agent.max_escalations` | integer | `1` | file-ack+attempt |
| `agent.max_retry_backoff_ms` | integer | `300000` | hot |
| `agent.required_skills` | list of names | `[]` | file-ack+attempt |
| `agent.approval_policy` | adapter-defined value | (required) | ack+attempt |
| `agent.thread_sandbox` | adapter-defined value | (required) | ack+attempt |
| `agent.turn_sandbox_policy` | adapter-defined value | (required) | ack+attempt |
| `budget.per_attempt_tokens` | integer | `400000` | file-ack+attempt |
| `budget.per_attempt_usd` | number | `5.00` | file-ack+attempt |
| `budget.per_issue_usd` | number | `10.00` | file-ack+hot |
| `budget.rolling_24h_usd` | number | `50.00` | file-ack+hot |
| `budget.per_issue_tokens` | integer | `2000000` | file-ack+hot |
| `budget.rolling_24h_tokens` | integer | `10000000` | file-ack+hot |
| `budget.estimate_tokens_by_profile` | map profile → integer | `{economy: 100000, standard: 200000, deep: 300000}` | file-ack+hot |
| `budget.history_min_samples` | integer | `10` | file-ack+hot |
| `budget.history_window_samples` | integer | `50` | file-ack+hot |
| `compute.enabled_profiles` | list | `[economy, standard, deep]` | file-ack+attempt |
| `compute.route_profiles` | map role/class → logical profile | defaults of Section 8 | file-ack+attempt |
| `compute.risk_floor_rules` | ordered rule list | built-in rules of Section 4 | file-ack+attempt |
| `class.trivial_max_changed_lines` | integer | `25` | file-ack+attempt |
| `class.trivial_patterns` | list of globs | `[]` | file-ack+attempt |
| `class.risk_paths` | list of globs | `[]` | file-ack+attempt |
| `review.max_parallel_specialists` | integer | `2` | file-ack+attempt |
| `review.specialists` | list | defaults of Section 9.1 | file-ack+attempt |
| `review.required_checks` | list of names | `[]` | file-ack+hot |
| `review.accepted_check_conclusions` | list | `[success, neutral, skipped]` | file-ack+hot |
| `review.snapshot_timeout_ms` | integer | `30000` | hot |
| `review.settle_timeout_ms` | integer | `1800000` | hot |
| `review.quiet_period_ms` | integer | `0` | hot |
| `quality.audit_rate` | number 0–1 | `0.10` | file-ack+hot |
| `quality.escape_window_days` | integer | `14` | file-ack+hot |
| `learning.interval_issues` | integer | `25` | hot |
| `learning.max_rules` | integer | `25` | attempt |
| `learning.max_prompt_tokens` | integer | `4000` | attempt |
| `learning.rule_decay_issues` | integer | `100` | hot |
| `human.operators` | list of `{id, auth_subject, capabilities[], tracker_login?}` | (required, non-empty) | ack+hot |
| `human.reminder_hours` | integer | `24` | hot |
| `notify.command` | string | `null` | ack+hot |
| `notify.webhook_url` | string | `null` | ack+hot |
| `env.allowlist` | list of var names | `[]` | ack+attempt |
| `persistence.database_path` | path | `<service-data-root>/symphony-encore.sqlite3` | bootstrap |
| `persistence.lease_ttl_ms` | integer | `120000` | hot |
| `persistence.retention_days` | integer or null | `null` (indefinite) | ack+hot |
| `server.port` | integer | `8080` | restart |
| `server.host` | string | `"127.0.0.1"` | ack+restart |
| `server.auth_kind` | string | (required) | ack+restart |
| `server.session_secret` | secret reference | (required unless auth adapter supplies sessions) | ack+restart |
| `bootstrap.admin_credential` | secret reference | (required only while operator store is empty) | bootstrap |
| `ui.live_refresh_ms` | integer | `1000` | hot |

### 18.2 Value Semantics and Validation

- Secret-bearing values MUST use `$VAR` indirection (Section 15.2); `$VAR` resolving to empty is
  treated as missing.
- Path values expand `~`; a relative `workspace.root` resolves against the directory containing
  `WORKFLOW.md`; the effective root is normalized to an absolute path before use.
- Extensions MUST live below `extensions.<name>`; unknown extension names, unknown top-level
  namespaces, and unknown keys inside a core namespace are ignored with an operator-visible warning
  so a newer workflow remains forward-compatible with an older binary. A safety-critical near miss
  is instead a validation error. The safety-critical top-level namespaces are `budget`, `hooks`,
  `agent`, `workspace`, `env`, `human`, `tracker`, `server`, `bootstrap`, `persistence`, `notify`,
  `review`, `compute`, `class`, and `quality`. Reject (a) an unknown top-level namespace whose
  lowercase Levenshtein distance from one of those names is at most 2, or (b) within one of those
  namespaces, an unknown final key segment whose distance from a defined sibling is at most 2.
  Warnings and errors include the full key and closest known key. Blank strings in list values are
  validation errors.
- Startup validation failure fails startup. Per-tick validation failure skips dispatch but keeps
  reconciliation running. Invalid reloads keep the last known good configuration and emit an
  operator-visible error.
- Validation checks at minimum: tracker keys for the selected kind; priority entries normalize to
  integers; the configured tracker status field exposes all Section 5.1 lanes and write authority;
  `workspace.verify_command` present (or `none` with reason); commands non-empty;
  required skills discoverable; approval/sandbox values supported by the adapter; retry/rework/plan
  limits, token budgets, and estimates positive; history sample minimum positive and no greater than
  its window; per-attempt,
  per-issue, and fleet USD budgets positive when the adapter is priced; enabled logical profiles and
  route mappings resolve through the adapter; accepted check conclusions supported; operators
  non-empty with unique ids/subjects/logins and at least one operator holding `config.write` and
  `config.ack`;
  authentication configured; database path local and writable with compatible schema.

These are ordinary-mode requirements. The only startup exemption is the empty-store operator and
auth-subject mapping described in Section 15.3; bootstrap still validates the authentication adapter
and every other field, then full validation must pass before orchestration is enabled.

If `review.quiet_period_ms > 0`, the complete PR snapshot must remain materially unchanged for that
period before the gate allows. Material fields are head/base SHA, mergeability, required-check
status/conclusion, review decision, and unresolved-thread identity. Pending checks/reviews are
polled until `review.settle_timeout_ms`; timeout routes to `Human(blocked)` with a typed
pending-evidence reason, not to rework.

### 18.3 Durable Operator Overrides

Effective configuration resolves in this order:

1. built-in defaults;
2. the parsed `WORKFLOW.md` front matter;
3. active durable operator overrides.

For every non-bootstrap key, an override record contains `key`, typed `value` or secret reference,
`version`, `created_by`,
`created_at`, `reason`, validation result, acknowledgment state, reload state, and optional expiry.
Create, update, and clear require `expected_version` and `idempotency_key`. Clearing reveals the
current workflow/default candidate; if that candidate requires acknowledgment or restart, it remains
pending under the same rules.

The UI MUST show the workflow value even when overridden, the effective value, source, candidate
version, and pending state. A workflow reload cannot overwrite an active override. Invalid override
requests return `422` and do not change the last known good configuration. Overrides take effect
only after the durable record, validation, required acknowledgment, and applicable reload boundary
have completed. Every new Attempt and SystemJob pins the resulting immutable snapshot.

Secret values themselves cannot be entered or returned through the UI. Operators may set only a
`$VAR` reference or adapter-owned secret reference; resolution occurs at the trusted boundary.

## 19. Conformance and Validation

### 19.1 Conformance Profiles

- **Core Conformance** requires every MUST in Sections 1–18, including a transactional local SQLite
  durable store, one conforming tracker adapter, one conforming repository-hosting adapter, one conforming
  agent adapter, the authenticated Control API, the visual UI, indefinite default history,
  orchestration/recovery, budgets, review, merge, and the deterministic tests in Section 19.2.
- **Extension Conformance** applies to an optional capability an implementation advertises, such as
  webhook-triggered ticks, additional adapters, or remote worker execution. The extension MUST
  publish its schema, authority, failure, durability, UI, and test contracts and MUST preserve Core
  invariants.
- **Real Integration Profile** exercises the selected tracker, repository host, agent provider,
  authentication, UI, hooks, and landing/deployment path with real credentials in a non-production
  repository. It is REQUIRED before an implementation is declared production-ready.

A conformance report names the implementation version, spec version, adapters and versions,
enabled extensions, test command, deterministic result, real-integration result, and any
implementation-defined choices. Partial implementation of a Core requirement cannot be reported as
Core Conformance.

### 19.2 Core Conformance Test Matrix

A conforming implementation MUST ship automated deterministic tests for all of the following.

**Workflow and configuration**

- Honor trusted workflow-path precedence; parse optional YAML front matter plus strict Markdown
  prompt; detect reloads; reject missing files, malformed/non-map YAML, empty prompt, unknown
  variables/filters, safety-critical near-miss keys at both top-level and field-level, empty required
  values, and literal secrets; warn visibly and ignore other unknown configuration keys.
- Resolve default → workflow → operator override; show each source/version; persist overrides across
  restart; clear an override back to the current file/default candidate; reject stale expected
  versions and invalid candidates without changing the last known good configuration.
- Show bootstrap-only keys read-only and reject durable override attempts for them.
- Reject bootstrap keys in `WORKFLOW.md`; accept them only from trusted startup arguments/environment.
- Hold every `ack+` candidate and every workflow-originated `file-ack+` candidate pending until an
  authorized acknowledgment of the exact hash; let an authorized `file-ack+` UI override apply
  directly at its hot/attempt boundary; expose pending state in UI/API.
- Bootstrap the first administrator through the one-time loopback credential + hash-confirmation
  flow only on a pristine store; prove external mutations and dispatch remain disabled, roll back
  partial failure, rerun full validation, reject credential reuse and unauthenticated remote setup,
  and require UI/API acknowledgment thereafter. With an operator-empty non-pristine fixture,
  terminate recorded processes, query unresolved intents without new mutation, reject bootstrap, and
  fail closed for database restoration.
- Resolve required skills and adapter capabilities before charging an attempt.

**Durable control plane and recovery**

- Atomically acquire a work-ref claim and create an Attempt plus budget reservation; a second issue
  or SystemJob dispatch is impossible; open an issue StageTransition only after the lane-mutation
  receipt and enforce baseline/attempt nullability invariants.
- Renew running leases; preserve non-expiring Ready/RetryQueued/AwaitingHuman reservations; rebuild
  ready actions, retry timers, parked predicates, questions/approval requests, comment cursors, stage
  timing, and rolling budgets after restart.
- Verify or terminate recorded process ownership; close interrupted work as `agent_process`; never
  resume an unverifiable process blindly.
- Reconcile each side-effect intent without a receipt by idempotency key and never duplicate a
  tracker, PR, branch, merge, notification, or control mutation; reject every mutating adapter call
  whose common authorization envelope has the wrong actor/role/capability, config snapshot,
  observed state, scope, target, revision, or expiry, including fleet notifications without a work
  reference.
- Stop dispatch and privileged mutations on persistence failure; stop workers that cannot be
  accounted or committed safely.

**Plans, attempts, and routing**

- Reject malformed or duplicate role results into one ExecutionFailure; reject an implementation
  `completed` result without agent verification evidence; independently run the pinned verification
  command, require a passing Verification Record for review, and route a failed record to rework;
  atomically store each valid role-specific result and associated Review Record.
- Validate typed Plan criterion coverage and commands; allow an unknown-only provisional `standard`
  route to become first-authoritative `trivial`, then move only upward within a cycle and apply newly
  required gates before work proceeds.
- Exercise `trivial`, `standard`, and `high_risk` plan/review routes, every PlanReviewResult decision,
  bounded rejected Plan revisions, issue-readiness `needs_input`, rework/no-progress caps, and factual
  fresh-attempt handoff; validate every conditional PlanReview, Review, Adjudication, and Synthesis
  result field.
- Keep one pinned profile/model per attempt/thread; a salvage turn uses it or creates a separately
  accounted attempt.

**Budgets, tokens, cost, and time**

- Deduplicate repeated/replayed absolute token events and persist UsageSamples plus correct Attempt,
  SystemJob, issue, role, class, profile, and rolling totals.
- Reserve expected usage before dispatch and fan-out, reject reservations that do not fit, replace
  reservation with actual usage, top up atomically or stop before further turns, release unused
  reservation, and surface delayed-reporting overruns without further dispatch.
- Enforce per-attempt/per-issue/fleet USD scopes for priced adapters and corresponding token scopes
  for unpriced adapters; hard-cap an attempt by tokens and priced USD with an orchestrator-authored
  `budget_exhausted` result and latest durable handoff; park/pause and resume/reset through audited
  operator actions without deleting history.
- Reconstruct total elapsed time and duration per stage from durable timestamps across restart.

**Review, merge, quality, and learning**

- Require complete current-head checks, accepted conclusions, no unresolved non-outdated threads,
  no blocking current review, and authorized human approval when supervised.
- Pin Review Records and the aggregate ReviewSet to one SHA; reject partial reviewer sets and
  tracker-comment evidence; require every mandated reviewer and no unresolved blocking finding for
  approval; union findings without voting, adjudicate only contrary blocking findings, and retain
  uncontested blockers.
- Serialize per repository; after base advance require fresh checks and compare normalized patch
  identity; for an identical patch create a new current-head ReviewSet linked to the prior set and
  carry-forward Guard Decision, allow only the linked prior set's Review Records to remain old-head,
  and require current-head verification/guards; require fresh review for a changed identity.
- Create a linked repair PR after attributable post-merge failure; keep independent repository queues
  moving; record escaped defects, demotion, notification, and durable evidence.
- Run sampled audits against recorded revisions; create lessons and repair work for blocking results;
  run synthesis as a budgeted SystemJob and enforce rule/prompt saturation and supervised merge.

**UI, API, and durable history**

- Render operations, issue/run history, and settings/control surfaces using only Control API data.
- Show current stage, time per stage, live durable logs/actions, all attempts and prior ServiceRuns,
  verification/review/evidence, token/cost/time history, effective settings and sources, audit history,
  and working issue/PR links after completion and restart.
- Normalize command/file/tool/network action fixtures into durable scrubbed LogRecords, group them by
  StageTransition in the UI, and preserve bounded output references across restart.
- Create/update/clear cost and other settings through the UI; show committed values only; surface
  validation, conflict, authorization, and server failures without losing the submitted value.
- Enforce authentication, capability checks, same-origin and CSRF protection, expected versions,
  mutation idempotency, structured errors, secret redaction, scoped `agent.approve`, and
  OperatorAction audit records; audit every authenticated rejection before returning and reject
  same-scope idempotency-key reuse with a different payload. Use OperatorAction alone for a pure
  internal control mutation and require MutationAuthorization plus SideEffectIntent only when that
  action performs external work.
- Escape hostile issue/log/tool content, reject unsafe links, and enforce the UI Content Security
  Policy without breaking log/history inspection.
- Retain logs/events/history indefinitely by default; apply explicit finite retention/deletion only
  through audited controls; preserve protected records and show tombstones with retained aggregates.

**Workspace and security**

- Enforce a write boundary beneath the resolved assigned workspace; reject absolute external writes,
  `..` traversal, in-workspace symlinks/bind paths targeting outside, and cross-work ownership;
  quarantine unowned workspaces and terminate the full process tree on every end state.
- Give agent/hooks only the allowlist, minimal baseline, and isolated credential-free HOME; prove
  tracker/repository/control credentials are unavailable to agent and reviewer processes.
- Apply tracker, repository-hosting, and notification mutations only through typed scoped adapters
  with common authorization, current revision, and durable intent/receipt evidence; apply control
  mutations only through the authenticated versioned API and OperatorAction contract.

### 19.3 Real Integration Profile

Before production readiness, run a smoke issue through `Todo → In Progress → Review → Done` using
the selected real adapters. Verify plan/classification, workspace population, agent protocol,
verification command, PR link, required checks, supervised approval, merge, post-merge checks, UI
live logs, stage timing, tokens/cost, and history after service restart. Also exercise one Human
question, one rejected stale UI mutation, one privileged acknowledgment, one budget denial, one
idempotent mutation replay, and one repair PR path. The report records identifiers and redacted
evidence, never credentials.

### 19.4 Reference Algorithms

```text
start_service():
  resolve bootstrap-only workflow/database paths from trusted args/environment
  open local SQLite; acquire the single-writer lock; apply migrations transactionally
  load defaults + WORKFLOW.md + durable overrides; inspect pristine/operator state
  if operator store is empty and database is non-pristine:
    load recorded sessions/intents; terminate owned processes; query intent status without mutation
    record operator_store_missing_nonpristine; require known-good database restore; return failure
  if database is pristine:
    validate under the narrow bootstrap exemptions; keep dispatch/external mutations disabled
    start loopback-only bootstrap; require trusted one-time credential + exact candidate hash
    atomically create admin, auth mapping, acknowledgment snapshot, and bootstrap OperatorAction
    on failure roll back completely; on success disable bootstrap credential and rerun full validation
  else validate adapters, auth/operators, required skills, acknowledgment and restart state normally
  create ServiceRun
  start authenticated Control API and UI in recovering/read-only mode
  load open attempts, claims, retries, parked work, stages, budgets, and side-effect intents
  verify/terminate process ownership; reconcile intents by idempotency key
  close prior ServiceRun as interrupted; rebuild timers/cursors; close interrupted results
  clean terminal unclaimed workspaces
  schedule immediate poll; expose startup result durably; enable authorized control mutations
```

```text
dispatch(work):
  require eligible issue or queued SystemJob, unclaimed work_ref, adapter preflight, slot, and class
  snapshot effective config; select logical profile; compute and require budget reservation
  transactionally create work-ref Claim + Attempt + all-scope reservations + dispatch-pending event
  for issue: commit authorized lane-change intent and apply through tracker adapter
             after receipt, open confirmed StageTransition
  for SystemJob: atomically open its durable running StageTransition; perform no tracker mutation
  prepare workspace; enforce write boundary; run hooks; launch credential-free agent process group
  on launch failure, close Attempt, settle reservation, and route through failure policy
```

```text
finish_attempt(attempt, terminal_result):
  validate the schema for attempt.role and the pinned budget/revision
  transactionally store result/review, final usage, logs, evidence, requested-action intents,
    next claim mode, and routing decision; close/open StageTransitions only when the confirmed
    tracker lane or durable SystemJob stage actually changes
  terminate and confirm process tree; run after_run best effort
  apply committed intents through typed adapters and store receipts
  reconcile resulting tracker/repository revisions before releasing or changing the claim
```

```text
activate_override(operator, request):
  authenticate; bind key to actor/endpoint/target/request hash
  on idempotency conflict, CSRF/capability/version/validation rejection: store OperatorAction; return error
  return original result only when the scoped key and request hash both match
  transactionally store accepted OperatorAction and override revision
  if ack-modified, require a second action bound to candidate hash
  apply at hot/attempt/restart boundary; preserve last known good on any failure
  create immutable config snapshot metadata; return effective value, source, and pending state
```

```text
control_mutation(operator, request):
  authenticate; bind key to actor/endpoint/target/request hash
  on idempotency conflict, CSRF/capability/version/validation rejection: store OperatorAction; return error
  return original receipt only when the scoped key and request hash both match
  authorize against pinned config + current immutable state/revision
  commit accepted OperatorAction and the internal state change transactionally
  only when external work is required: also commit MutationAuthorization + SideEffectIntent first
  if external work exists: apply through adapter; commit receipt and resulting revision
  publish durable event; return committed state
```

## Appendix A. Changes from v2

Cut: nine lanes → six (rework/blocked/questions became attributes); the redundant config cheat
sheet; SSH worker appendix; broad `linear_graphql` /
`github_graphql` tools; per-state concurrency map; workpad-as-input (now projection-only);
humanized event summaries; ~70% of the text.

Fixed: cost is durable and enforced through reservation plus priced/unpriced scopes; merge decisions
read durable review records rather than tracker prose; each attempt pins one role/profile; synthesis
is a SystemJob; infrastructure failures do not consume agent retry counts; retry and Human
reservations survive restart; non-login credential-free environments replace inherited login-shell
state; every executable/authority-changing candidate requires acknowledgment; provider model names
remain adapter-owned.

Added: typed plans and role results; staged classification; required verification; repository-hosting
adapter; revision-pinned merge queue; repair PRs and reproducible audits; graduated autonomy;
structured questions and notifications; learning synthesis and saturation; escaped-defect metrics;
required authenticated UI/API; durable logs, stage timing, usage, prior-run history, and indefinite
default retention; editable versioned operator overrides; a guided first-run setup contract with
optional tracker schema remediation; Core, Extension, and Real Integration conformance profiles.

## Appendix B. Normalized Agent Events and the Codex Reference Adapter

### B.1 Normalized Upstream Events (all adapters)

Adapters translate their provider protocol into exactly this event set. Every event carries
`event`, `timestamp` (UTC), and `attempt_id`; `session_id` is nullable until session identity is
established. Process-bearing events carry the subprocess pid.

- `session_started` — thread and turn identity established; payload: `thread_id`, `turn_id`,
  `model`, `reasoning_effort`.
- `startup_failed` — protocol handshake, capability, or schema incompatibility; payload:
  `error_code`. MUST fire before the execution is charged where detectable.
- `turn_completed` / `turn_failed` / `turn_cancelled` — turn end states; payload: provider reason.
- `turn_input_required` — the agent requested operator input mid-turn.
- `action_started` / `action_completed` / `action_failed` — a command, file change, tool call,
  network fetch, or other agent action; payload: stable `action_id`, `kind`, scrubbed summary, `cwd`,
  and, on completion, exit/result status plus bounded output reference. These events feed durable
  stage-grouped UI history.
- `approval_requested` / `approval_auto_approved` — approval flow per documented policy.
- `unsupported_tool_call` — the agent invoked a tool the runtime does not implement; the adapter
  MUST return a tool-failure result to the session and continue rather than stall.
- `token_usage` — absolute session totals per Section 7.2.
- `rate_limit` — latest provider rate-limit snapshot.
- `terminal_result_reported` — the schema-validated result for the current Attempt role.
- `notification` — informational passthrough (progress text); observability only.
- `malformed` — an unparseable protocol message; counted, never interpreted.

Orchestrator logic MUST depend only on these events, never on provider-specific payloads or
humanized strings.

### B.2 Normalized Error Mapping (all adapters)

Adapter-detected failures map to these codes, which map to Section 13 classes:

| Error code | Meaning | Failure class |
|---|---|---|
| `agent_not_found` | executable missing/unlaunchable | `configuration` |
| `protocol_incompatible` | version/schema/capability mismatch | `configuration` |
| `invalid_workspace_cwd` | workspace validation failed at launch | `policy` |
| `auth_failed` | provider rejected credentials | `auth` |
| `response_timeout` | startup/sync request exceeded read timeout | `agent_process` |
| `turn_timeout` | turn exceeded `agent.turn_timeout_ms` | `agent_process` |
| `stalled` | no events for `agent.stall_timeout_ms` | `agent_process` |
| `process_exit` | subprocess died mid-turn | `agent_process` |
| `turn_failed` / `turn_cancelled` | provider-reported turn failure | `agent_process` |
| `turn_input_required` | input required and policy says fail | `task` |
| `token_cap_exceeded` | `budget.per_attempt_tokens` reached | orchestrator-authored `budget_exhausted` ExecutionFailure |
| `usd_cap_exceeded` | `budget.per_attempt_usd` reached | orchestrator-authored `budget_exhausted` ExecutionFailure |
| `result_missing` / `result_invalid` | no valid role result after permitted salvage | `agent_process` |
| `overloaded` | provider capacity / rate limited | `infrastructure` |

### B.3 Codex App-Server Reference Profile

- Launch: `bash -c "<agent.command>"` (default `codex app-server`), `cwd` = workspace path,
  enforced write boundary (Section 6.1), scrubbed env (Section 15.2), stdio transport. Bound
  protocol-line size (10 MB recommended) and a
  bounded inbound queue with backpressure or fail-fast overflow.
- The installed Codex version's generated schema
  (`codex app-server generate-json-schema`) is the protocol source of truth; this specification
  never restates protocol shapes. On conflict, Codex controls protocol; Symphony controls
  orchestration.
- Startup: initialize and negotiate capabilities per the targeted protocol **before** the Attempt
  is charged; create or resume a thread with the workspace as the thread/turn `cwd`; supply the
  documented approval/sandbox settings; advertise one `report_result` tool with the current
  Attempt-role schema (Sections 3.3 and 3.17) plus conditional `submit_plan` and
  other narrow typed tools; set the turn/session title to `<work-ref>: <title>` when supported.
- Turns: first turn sends the rendered prompt; continuation turns within one Attempt reuse the
  live thread and send only the Section 5.3 continuation guidance. `session_id =
  <thread_id>-<turn_id>`.
- Token payloads: prefer absolute thread totals (`thread/tokenUsage/updated`-style payloads);
  ignore delta-style fields (`last_token_usage`) when computing totals.
- Approvals: per documented deployment policy (Section 15.4); auto-approvals emit
  `approval_auto_approved`.
- Shutdown on any end state: cancel pending requests, close transport, terminate the process
  group, confirm exit within a bounded grace period, then release the work-ref Claim.
