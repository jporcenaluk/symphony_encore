# Symphony Encore Service Specification

Status: Draft v2 (language-agnostic core with implementation profiles)

Purpose: Define a durable, cost-aware service that orchestrates coding agents to complete project
work with explicit evidence, bounded autonomy, and independent review.

This specification derives from `openai/symphony` and the extended `jporcenaluk/symphony` fork. It
keeps portable behavior normative and marks Codex, GitHub SDLC, and TypeScript details as profiles.
An implementation can replace any profile without changing the core orchestration contract.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from an issue tracker,
creates an isolated workspace for each issue, and runs a
coding agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations target trusted environments with a high-trust configuration, while others require
stricter approvals or sandboxing.

Important boundary:

- Symphony Encore is a scheduler, durable control plane, policy enforcer, and agent runner.
- The orchestrator owns deterministic workflow state and guarded side effects. Agents propose typed
  outcomes and actions; policy code validates and applies them through narrow adapters.
- Raw tracker, repository-hosting, or control-plane credentials SHOULD NOT be exposed to agents.
  Broad pass-through tools are compatibility extensions, disabled by default.
- A successful run can end at a workflow-defined handoff state (for example `Risk Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Persist claims, attempts, retries, outcomes, configuration snapshots, and guard decisions so a
  process restart does not erase control-plane truth.
- Match model capability and reasoning effort to task phase and risk while preserving deterministic
  quality floors.
- Require independent integrative review and add specialist reviewers only when risk warrants their
  cost.
- Make every retry, escalation, side effect, and review decision bounded, attributable, and
  observable.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Mandating one universal business process for how to edit tickets, PRs, or comments. Core Symphony
  may be deployed with a read-only tracker adapter; when writes are enabled, they follow the guarded
  mutation contract in Section 11.6.
- Requiring a distributed workflow engine for a single-host deployment.
- Treating more agents, more tokens, or a larger model as substitutes for tests and other objective
  evidence.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

### 2.3 Conformance and Profiles

The document has four separable contracts:

- `Core Conformance`: durable orchestration, workspaces, outcomes, retries, adaptive compute,
  review coordination, safety, and observability. It is language-, tracker-, and provider-neutral.
- `Agent Profile`: a versioned adapter for a coding-agent protocol. Section 10 defines the Codex
  profile used by the first Encore implementation.
- `Workflow Profile`: tracker and delivery policy. Sections 11.2 and 11.3 define Linear and GitHub
  tracker profiles; Section 12.5 defines the GitHub SDLC profile.
- `Implementation Profile`: a concrete language and process topology. Appendix B defines the
  recommended TypeScript profile.

Conformance reports MUST name the core version and every selected profile. A profile can add
requirements but cannot weaken a core safety, durability, outcome, or review requirement.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Is the sole writer of durable orchestration state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Durable State Store`
   - Stores leases, attempts, retries, outcomes, configuration snapshots, and guard decisions.
   - Supports atomic compare-and-set or transactional claim transitions.
   - Allows restart reconciliation without pretending a terminated agent process is still live.

6. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

7. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the coding agent app-server client.
   - Streams agent updates and a required structured outcome back to the orchestrator.
   - Enforces protocol compatibility, backpressure, timeouts, and process-tree cleanup.

8. `Review Coordinator`
   - Runs deterministic checks before model review.
   - Requires one full-change integrative review.
   - Fans out focused specialist reviews only when risk rules trigger them.
   - Unifies evidence-backed findings without majority voting.

9. `Status Surface` (OPTIONAL)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

10. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, coding-agent protocol.

5. `Integration Layer` (tracker and agent adapters)
   - API calls, normalization, guarded mutations, and versioned protocol compatibility.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear`; GitHub Issues + GitHub Projects v2 for
  `tracker.kind: github`).
- Local filesystem for workspaces and logs.
- A local durable transactional store. The baseline profile uses SQLite on local disk with the
  worker process as its sole writer.
- OPTIONAL workspace population tooling (for example Git CLI, if used).
- Coding-agent executable that supports the targeted Codex app-server mode.
- Host environment authentication for the issue tracker and coding agent.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (examples: `ABC-123`, `#42`, or `owner/repo#42`).
- `number` (integer or null)
  - Tracker issue number when the tracker exposes one.
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `priority_name` (string or null)
  - Tracker priority label/value when the tracker exposes a named priority.
- `state` (string)
  - Current tracker state name.
- `tracker_item_id` (string or null)
  - Project-board item ID when the tracker separates issue ID from board item ID.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `assignee_id` (string or null)
  - Tracker assignee identifier used for worker routing, when configured.
- `repo_owner` (string or null)
- `repo_name` (string or null)
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
    - `url` (string or null)
    - `repo_owner` (string or null)
    - `repo_name` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- coding-agent executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `config_snapshot_id`
- `compute_profile` (logical profile selected for this attempt)
- `model` and `reasoning_effort` (resolved provider values)
- `routing_reasons` (ordered policy rule identifiers)
- `outcome` (structured outcome or null while running)
- `failure_class` (normalized retry class or null)
- `error` (OPTIONAL)

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a coding-agent subprocess is running.

Fields:

- `session_id` (string, `<thread_id>-<turn_id>`)
- `thread_id` (string)
- `turn_id` (string)
- `codex_app_server_pid` (string or null)
- `last_codex_event` (string/enum or null)
- `last_codex_timestamp` (timestamp or null)
- `last_codex_message` (summarized payload)
- `codex_input_tokens` (integer)
- `codex_output_tokens` (integer)
- `codex_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of coding-agent turns started within the current worker lifetime.
- `adapter_version` (string)
- `protocol_schema_hash` (string or null)
- `compute_profile`, `model`, and `reasoning_effort`

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)
- `failure_class` (normalized retry class)
- `max_attempts` (effective retry budget captured from the attempt's config snapshot)

#### 4.1.8 Orchestrator Runtime State

Single authoritative durable state owned by the orchestrator, plus ephemeral process handles and
timers that are rebuilt during startup reconciliation.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (durable leases for issue IDs reserved/running/retrying)
- `blocked` (map `issue_id -> blocked entry`)
  - Issues waiting on operator input, unavailable approvals, missing tools, missing auth, or another
    true external blocker.
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `codex_totals` (aggregate tokens + runtime seconds)
- `codex_rate_limits` (latest rate-limit snapshot from agent events)

#### 4.1.9 Pull Request Readiness Snapshot

Tracker implementations that can link issues to pull requests SHOULD expose a readiness snapshot.

Fields:

- `issue_id` (string)
- `issue_number` (integer or null)
- `pr_number` (integer or null)
- `pr_url` (string or null)
- `pr_state` (string or null)
- `head_sha` (string or null)
- `base_ref` (string or null)
- `merge_state` (string or null)
- `review_decision` (string or null)
- `checks` (list)
  - Each check has `name`, `status`, `conclusion`, and `url`.
- `reviews` (list)
  - Each review has `state`, `body`, `author`, `commit_sha`, and `submitted_at`.
- `review_threads` (list)
  - Each thread has `id`, `resolved`, `outdated`, `body`, `author`, `commit_sha`, and `url`.
- `pr_comments` (list)
- `issue_comments` (list)

#### 4.1.10 Workpad

A workpad is a single persistent tracker comment owned by the workflow. It is the durable handoff
artifact for one issue.

The workpad SHOULD contain:

- environment stamp: `<hostname>:<absolute-workdir>@<short-sha>`
- plan checklist
- acceptance criteria checklist
- validation checklist
- proof packet
- fresh-context correctness review result when applicable
- guard result when Symphony routes or blocks a protected transition
- notes and confusions

Implementations that support tracker comment reads/writes MAY parse the workpad to enforce readiness
rules. If they do, they MUST update the same comment rather than creating extra completion comments.

#### 4.1.11 Configuration Snapshot

An immutable, durable record of the effective configuration used by one attempt.

Fields:

- `id` and `created_at`
- `workflow_source_hash`
- `effective_config` with secret values redacted or represented by stable references
- `prompt_template_hash`
- `agent_adapter_version` and `protocol_schema_hash`

Every attempt MUST reference exactly one snapshot. An in-flight attempt MUST NOT observe a mixture
of old and newly reloaded settings.

#### 4.1.12 Run Outcome

The agent runner MUST return exactly one structured terminal outcome:

- `completed`: requested work and required evidence are complete.
- `needs_rework`: a concrete, actionable defect remains within task scope.
- `blocked`: an external dependency, permission, service, or policy prevents progress.
- `needs_input`: a material product or operator decision is required.
- `no_progress`: the attempt produced no new evidence or useful state change.
- `failed`: execution failed before a more specific outcome could be established.

Fields:

- `status` (one of the values above)
- `summary` (concise factual description)
- `evidence` (typed references to checks, files, commits, PRs, logs, or tracker artifacts)
- `actions_requested` (typed requests for orchestrator-owned side effects)
- `open_findings` (bounded list with severity, evidence, and suggested disposition)
- `handoff` (facts needed by a fresh thread; MUST exclude hidden reasoning and unsupported claims)

Free-form prose alone is not a conforming terminal result.

#### 4.1.13 Review Plan and Review Result

A review plan records the required integrative reviewer and any risk-triggered specialists. Each
review assignment specifies its concern slice, evidence inputs, excluded inputs, compute profile,
and budget. A review result contains a decision and evidence-backed findings. Reviewers MUST NOT
vote on a shared verdict; the coordinator merges findings and invokes adjudication only for a
material conflict.

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `lowercase`.
- `Session ID`
  - Compose from coding-agent `thread_id` and `turn_id` as `<thread_id>-<turn_id>`.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Design note:

- `WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`
- `readiness`
- `observability`
- `server`

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Supported values: `linear`, `github`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - MAY be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - REQUIRED for dispatch when `tracker.kind == "linear"`.
- `owner` (string)
  - REQUIRED for dispatch when `tracker.kind == "github"`.
  - GitHub user or organization that owns the Project v2 board.
- `project_number` (integer)
  - REQUIRED for dispatch when `tracker.kind == "github"`.
- `repo_owner` (string)
  - REQUIRED for dispatch when `tracker.kind == "github"` unless the implementation explicitly
    supports multi-repository dispatch.
- `repo_name` (string)
  - REQUIRED for dispatch when `tracker.kind == "github"` unless the implementation explicitly
    supports multi-repository dispatch.
- `status_field` (string)
  - Default: `Status`.
  - GitHub Project v2 single-select field used as the workflow state source of truth.
- `priority_field` (string)
  - Default: `Priority`.
  - GitHub Project v2 single-select field used for dispatch ordering.
- `priority_order` (list of strings)
  - Default: `["P0", "Urgent", "Critical", "P1", "High", "P2", "Medium", "P3", "Low"]`.
  - Earlier entries sort ahead of later entries; unknown or blank priorities sort last.
- `assignee` (string)
  - OPTIONAL. When set, candidate issues MUST be assigned to this tracker user to dispatch or
    continue.
- `required_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain every configured label to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - A blank configured label matches no issue.
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of coding-agent turns within one worker session.
  - Invalid values fail configuration validation.
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.
- `max_failure_retries` (non-negative integer)
  - Default: `3`
  - Maximum automatic retries for a retryable failure within one issue execution cycle.
- `max_no_progress_attempts` (positive integer)
  - Default: `2`
  - Reaching the limit routes the issue to `Blocked` or another configured operator lane.
- `max_compute_escalations` (non-negative integer)
  - Default: `1`
  - Limits fresh-thread escalation to a stronger compute profile for one logical attempt.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `codex` (object)

Fields:

For Codex-owned config values such as `approval_policy`, `thread_sandbox`, and
`turn_sandbox_policy`, supported values are defined by the targeted Codex app-server version.
Implementors SHOULD treat them as pass-through Codex config values rather than relying on a
hand-maintained enum in this spec. To inspect the installed Codex schema, run
`codex app-server generate-json-schema --out <dir>` and inspect the relevant definitions referenced
by `v2/ThreadStartParams.json` and `v2/TurnStartParams.json`. Implementations MAY validate these
fields locally if they want stricter startup checks.

- `command` (string shell command)
  - Default: `codex app-server`
  - The runtime launches this command via `bash -lc` in the workspace directory.
  - The launched process MUST speak a compatible app-server protocol over stdio.
- `approval_policy` (Codex `AskForApproval` value)
  - Default: implementation-defined.
- `thread_sandbox` (Codex `SandboxMode` value)
  - Default: implementation-defined.
- `turn_sandbox_policy` (Codex `SandboxPolicy` value)
  - Default: implementation-defined.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `read_timeout_ms` (integer)
  - Default: `5000`
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.
- `required_skills` (list of strings)
  - Default: `[]`
  - When set, the runtime SHOULD verify that each listed skill is installed in a repo-local or
    Codex-home skill directory visible to the Codex worker before dispatching work.
  - Implementations SHOULD check repo-local `.codex/skills`, the active Codex home skills directory,
    plugin cache paths, and the operator's agent skill directory when those locations exist.

#### 5.3.7 `readiness` (object)

Fields:

- `timeout_ms` (integer)
  - Default: `1800000`.
  - Maximum time a readiness guard may wait or poll before routing away from the protected transition.
- `quiet_period_ms` (integer)
  - Default: `90000`.
  - Minimum stable period used by implementations that poll for settling checks or comments.
- `required_checks` (list of strings)
  - Default: `[]`.
  - Named status checks that must be completed successfully, neutrally, or skipped on the current PR
    head before `Risk Review` may dispatch.
- `review_markers` (list of strings)
  - Default: `["P0", "P1", "P2", "blocker", "must fix"]`.
  - Case-insensitive markers used to classify top-level PR comments as actionable feedback.

#### 5.3.8 `observability` (object)

Fields:

- `dashboard_enabled` (boolean)
  - Default: `true`.
- `refresh_ms` (integer)
  - Default: `1000`.
- `render_interval_ms` (integer)
  - Default: `16`.

#### 5.3.9 `server` (object)

Fields:

- `port` (integer, OPTIONAL)
  - Enables the optional HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
- `host` (string)
  - Default: `127.0.0.1`.

#### 5.3.10 `persistence` (object)

Fields:

- `database_path` (path)
  - Default: `<service-data-root>/symphony-encore.sqlite3`.
  - The baseline profile requires a local-disk SQLite database.
  - Changing this field requires a service restart.
- `lease_ttl_ms` (positive integer)
  - Default: `120000`.
  - A live worker MUST renew its claim before the lease expires.
- `event_retention_days` (positive integer or null)
  - Default: `30`.
  - Retention MUST NOT remove the current state, active attempts, or evidence referenced by an open
    work item.

#### 5.3.11 `compute` (object)

The configuration uses logical profiles rather than embedding provider model names in workflow
policy. Each profile resolves to provider-specific `model` and `reasoning_effort` values.

Fields:

- `profiles` (map `profile_name -> provider settings`)
  - MUST define `economy`, `standard`, and `deep`, or documented equivalent names.
  - Provider settings MUST be validated against the active agent adapter before dispatch.
- `phase_profiles` (map `phase_name -> profile_name`)
  - Defines defaults for `discovery`, `implementation`, `integrative_review`, `specialist_review`,
    and `adjudication`.
- `risk_floor_rules` (ordered list of deterministic rules)
  - Each rule maps observable task/change facts to a minimum profile.
  - Security boundaries, migrations, concurrency, public API changes, cross-package architecture,
    and ambiguous acceptance criteria SHOULD floor the affected phase at `deep`.
- `review_budget_fraction_target` (number from `0` through `1`)
  - Default: `0.30`.
  - An observability and calibration target, not permission to skip required review.
- `sampled_deep_audit_rate` (number from `0` through `1`)
  - Default: `0.05`.
  - Fraction of lower-risk completed work sampled for a deep audit to detect routing blind spots.

Routing requirements:

- Deterministic risk rules establish the minimum profile for each phase.
- A heuristic or model-based classifier MAY raise that profile but MUST NOT lower the deterministic
  floor.
- The selected profile, resolved model, reasoning effort, and rule identifiers MUST be pinned in the
  attempt snapshot and recorded in events.
- A compute escalation MUST start a fresh thread with the structured factual handoff from the prior
  attempt. It MUST NOT silently change model or reasoning effort inside an existing thread.
- Model slugs and supported reasoning values belong to the agent adapter, not this specification.

#### 5.3.12 `review` (object)

Fields:

- `integrative_required` (boolean)
  - Default and REQUIRED value: `true`.
- `max_parallel_specialists` (integer)
  - Default: `2`.
- `specialists` (list)
  - Each entry declares `name`, `concerns`, `required_evidence`, `excluded_context`, `trigger_rules`,
    and `compute_profile`.
- `conflict_adjudication_profile` (profile name)
  - Default: `deep`.

The default specialist slices are:

- `systems_security`: security, permissions, data integrity, concurrency, reliability, and
  operational failure modes.
- `architecture_product`: architecture, API coherence, maintainability, product behavior, UX, and
  taste-dependent trade-offs.

The mandatory integrative reviewer covers the full change, acceptance criteria, regression risk,
and cross-slice interactions. Specialists supplement it; they never replace it.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on an issue from Linear.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection only for config values that explicitly contain `$VAR_NAME`.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and re-apply workflow config and prompt template without restart.
- Every valid reload MUST create a new immutable configuration snapshot.
- Hot settings, including polling cadence, dispatch concurrency, and observability refresh rates,
  MAY affect the live scheduler after the snapshot is committed.
- Attempt-scoped settings, including prompt content, tracker filters, hooks, compute routing,
  review policy, timeouts, and retry budgets, apply only to attempts created from the new snapshot.
- Restart-required settings, including `persistence.database_path` and listener bindings, MUST be
  reported as pending and MUST NOT partially apply.
- In-flight attempts continue using their pinned snapshot. Implementations MUST NOT restart them
  automatically merely because configuration changed.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) MAY
  require restart unless the implementation explicitly supports live rebind.
- Implementations SHOULD also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution when the selected tracker requires a direct API
  key.
- `tracker.project_slug` is present when REQUIRED by the selected tracker kind.
- `tracker.owner`, `tracker.project_number`, `tracker.repo_owner`, and `tracker.repo_name` are present
  when REQUIRED by GitHub tracker mode.
- `codex.command` is present and non-empty.
- `codex.required_skills`, when present, resolve to installed skill directories visible to the worker.
- `readiness.required_checks` and `readiness.review_markers` contain no blank strings.
- `persistence.database_path` resolves to a local, writable location and its schema is compatible.
- Compute profiles referenced by phase, risk, specialist, and adjudication rules exist and are
  supported by the selected agent adapter.
- `review.integrative_required` is `true`, specialist definitions have distinct concern slices, and
  review budgets are valid.

### 6.4 Core Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.
Profile fields are documented in the section that defines them. Core fields in this summary are
always required; profile fields are required when that profile is selected.

- `tracker.kind`: string, REQUIRED, `linear` or `github`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY` when `tracker.kind=linear`
- `tracker.project_slug`: string, REQUIRED when `tracker.kind=linear`
- `tracker.owner`: GitHub Project owner, REQUIRED when `tracker.kind=github`
- `tracker.project_number`: GitHub Project number, REQUIRED when `tracker.kind=github`
- `tracker.repo_owner`: GitHub issue repository owner, REQUIRED when `tracker.kind=github`
- `tracker.repo_name`: GitHub issue repository name, REQUIRED when `tracker.kind=github`
- `tracker.status_field`: string, default `"Status"` when `tracker.kind=github`
- `tracker.priority_field`: string, default `"Priority"` when `tracker.kind=github`
- `tracker.priority_order`: list of strings, default `["P0", "Urgent", "Critical", "P1", "High", "P2", "Medium", "P3", "Low"]`
- `tracker.assignee`: string, optional worker routing filter
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_failure_retries`: non-negative integer, default `3`
- `agent.max_no_progress_attempts`: positive integer, default `2`
- `agent.max_compute_escalations`: non-negative integer, default `1`
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `codex.command`: shell command string, default `codex app-server`
- `codex.approval_policy`: Codex `AskForApproval` value, default implementation-defined
- `codex.thread_sandbox`: Codex `SandboxMode` value, default implementation-defined
- `codex.turn_sandbox_policy`: Codex `SandboxPolicy` value, default implementation-defined
- `codex.turn_timeout_ms`: integer, default `3600000`
- `codex.read_timeout_ms`: integer, default `5000`
- `codex.stall_timeout_ms`: integer, default `300000`
- `codex.required_skills`: list of strings, default `[]`
- `readiness.timeout_ms`: integer, default `1800000`
- `readiness.quiet_period_ms`: integer, default `90000`
- `readiness.required_checks`: list of strings, default `[]`
- `readiness.review_markers`: list of strings, default `["P0", "P1", "P2", "blocker", "must fix"]`
- `observability.dashboard_enabled`: boolean, default `true`
- `observability.refresh_ms`: integer, default `1000`
- `observability.render_interval_ms`: integer, default `16`
- `server.port`: integer, optional
- `server.host`: string, default `"127.0.0.1"`
- `persistence.database_path`: local path, default `<service-data-root>/symphony-encore.sqlite3`
- `persistence.lease_ttl_ms`: positive integer, default `120000`
- `persistence.event_retention_days`: positive integer or null, default `30`
- `compute.profiles`: logical profile map, REQUIRED
- `compute.phase_profiles`: phase-to-profile map, REQUIRED
- `compute.risk_floor_rules`: ordered deterministic rule list, REQUIRED
- `compute.review_budget_fraction_target`: number, default `0.30`
- `compute.sampled_deep_audit_rate`: number, default `0.05`
- `review.integrative_required`: boolean, REQUIRED `true`
- `review.max_parallel_specialists`: integer, default `2`
- `review.specialists`: focused specialist definitions
- `review.conflict_adjudication_profile`: profile name, default `deep`

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn on the same live
  coding-agent thread in the same workspace, up to `agent.max_turns`.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
- Once the worker exits normally, its structured outcome determines the next transition. The
  orchestrator MAY schedule a short continuation only when policy requires another session, the
  refreshed issue remains eligible, and the continuation budget has not been exhausted.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `ReportingOutcome`
8. `Completed`
9. `NeedsRework`
10. `Blocked`
11. `NeedsInput`
12. `NoProgress`
13. `Failed`
14. `TimedOut`
15. `Stalled`
16. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Validate the required structured outcome.
  - Apply the deterministic outcome transition; continuation is permitted only when the outcome and
    refreshed tracker state require it and the continuation budget remains.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Codex Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- Claims MUST be acquired transactionally before launching a worker and MUST use renewable leases.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Every external mutation MUST carry an idempotency key derived from the issue, attempt, requested
  action, and target revision when the integration supports one.
- An attempt record MUST be committed before its agent process starts.
- An outcome and its requested side effects MUST be committed before side effects are applied.
- Reconciliation runs before dispatch on every tick.
- Restart recovery reconciles durable state, tracker state, workspace state, and live-process
  evidence. Expired leases become recoverable; the service MUST NOT assume an old process survived.
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

### 7.5 Outcome Transition Contract

The orchestrator maps structured outcomes to policy; the agent does not choose the final tracker
transition directly.

- `completed`: verify required evidence and guards, apply approved side effects, then release or move
  to the workflow-defined handoff lane.
- `needs_rework`: preserve the workspace and route to targeted rework with the findings attached.
- `blocked`: record the external blocker, hold or release the claim according to workflow policy,
  and wait for a detectable state change.
- `needs_input`: route to the configured operator lane with the exact decision requested.
- `no_progress`: retry only within `agent.max_no_progress_attempts`; then route to operator review.
- `failed`: classify the failure before deciding whether retry is allowed.

Missing, malformed, contradictory, or evidence-free outcomes are protocol failures. They MUST NOT be
treated as success.

### 7.6 Failure Taxonomy and Retry Budgets

Every failure MUST map to one category:

- `transient_external`: network interruption, service unavailability, or rate limiting; retryable.
- `capacity`: no slot or provider capacity; retryable without charging the task failure budget.
- `agent_process`: crash, protocol interruption, timeout, or stall; retryable within budget.
- `configuration`: invalid workflow, missing executable, or incompatible adapter; not retryable until
  the relevant configuration or capability changes.
- `authentication_or_permission`: missing or insufficient authority; not retryable until credentials
  or permissions change.
- `policy_or_safety`: denied side effect, unsafe path, prompt-injection boundary, or approval failure;
  not automatically retryable.
- `task`: deterministic test failure, irreconcilable acceptance criteria, or repeated no progress;
  route to rework, input, or blocked according to evidence.

Retries MUST be bounded by the captured attempt configuration. A retry MUST record its category,
budget consumption, next eligible time, and the external fact that would unblock any non-retryable
failure. Repeating the same non-retryable failure without new evidence is prohibited.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval SHOULD be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is routed to this worker by the configured assignee and contains every
  label in `tracker.required_labels`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Policy-approved continuation retries after a valid `completed` outcome use a short fixed delay of
  `1000` ms and consume a continuation budget.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).
- Rate-limit responses SHOULD honor a provider-supplied retry time when it is later than the
  computed delay.
- Randomized jitter SHOULD be applied to transient external retries to avoid synchronized retry
  storms.

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.
6. If the captured retry budget is exhausted, do not requeue; persist a terminal outcome and route
   according to the failure taxonomy.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running issues).
- Retry handling mainly operates on active candidates and releases claims when the issue is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_codex_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > codex.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized absolute path)

Per-issue workspace path:

- `<workspace.root>/<sanitized_issue_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue.identifier`

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 OPTIONAL Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations MAY populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations MAY remove the partially
  prepared directory.
- Reused workspaces SHOULD NOT be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path MUST stay inside workspace root.

- Resolve both paths to canonical absolute paths, including symlinks for existing components.
- Require `workspace_path` to be a descendant path of `workspace_root`; a string prefix check alone
  is insufficient.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

Invariant 4: One issue lease owns one mutable workspace.

- A workspace MUST NOT be attached to concurrent attempts.
- Startup reconciliation MUST quarantine a workspace when ownership cannot be established.

Invariant 5: Termination covers the full process tree.

- The runner MUST launch the agent in an identifiable process group, job object, container, or
  equivalent boundary.
- Cancellation, timeout, stall, and shutdown MUST terminate descendants, then verify they exited
  before releasing the workspace lease.

## 10. Agent Runner Protocol (Coding Agent Integration)

This section defines Symphony's language-neutral responsibilities when integrating a Codex
app-server. The Codex app-server protocol for the targeted Codex version is the source of truth for
protocol schemas, message payloads, transport framing, and method names.

Protocol source of truth:

- Implementations MUST send messages that are valid for the targeted Codex app-server version.
- Implementations MUST consult the targeted Codex app-server documentation or generated schema
  instead of treating this specification as a protocol schema.
- If this specification appears to conflict with the targeted Codex app-server protocol, the Codex
  protocol controls protocol shape and transport behavior.
- Symphony-specific requirements in this section still control orchestration behavior, workspace
  selection, prompt construction, continuation handling, and observability extraction.
- Each provider integration MUST be isolated behind a versioned adapter. The adapter MUST publish
  its supported protocol range, generated-schema hash when available, required capabilities, and
  normalized event mappings.

### 10.1 Launch Contract

Subprocess launch parameters:

- Command: `codex.command`
- Invocation: `bash -lc <codex.command>`
- Working directory: workspace path
- Transport/framing: the protocol transport required by the targeted Codex app-server version

Notes:

- The default command is `codex app-server`.
- Approval policy, sandbox policy, cwd, prompt input, and OPTIONAL tool declarations are supplied
  using fields supported by the targeted Codex app-server version.

RECOMMENDED additional process settings:

- Max line size: 10 MB (for safe buffering)
- A bounded inbound event queue with explicit backpressure or fail-fast overflow behavior
- A process-group or equivalent lifecycle boundary for descendant cleanup

### 10.2 Session Startup Responsibilities

Reference: https://developers.openai.com/codex/app-server/

Startup MUST follow the targeted Codex app-server contract. Symphony additionally requires the
client to:

- Start the app-server subprocess in the per-issue workspace.
- Initialize the app-server session using the targeted Codex app-server protocol.
- Complete initialization and capability negotiation before starting a thread.
- Verify required methods, notification shapes, tool support, approval modes, model settings, and
  reasoning-effort values against the selected adapter.
- Reject an incompatible server before an issue lease is charged with an execution attempt.
- Create or resume a coding-agent thread according to the targeted protocol.
- Supply the absolute per-issue workspace path as the thread/turn working directory wherever the
  targeted protocol accepts cwd.
- Start the first turn with the rendered issue prompt.
- Start later in-worker continuation turns on the same live thread with continuation guidance rather
  than resending the original issue prompt.
- Supply the implementation's documented approval and sandbox policy using fields supported by the
  targeted protocol.
- Include issue-identifying metadata, such as `<issue.identifier>: <issue.title>`, when the targeted
  protocol supports turn or session titles.
- Advertise implemented client-side tools using the targeted protocol.

Session identifiers:

- Extract `thread_id` from the thread identity returned by the targeted Codex app-server protocol.
- Extract `turn_id` from each turn identity returned by the targeted Codex app-server protocol.
- Emit `session_id = "<thread_id>-<turn_id>"`
- Reuse the same `thread_id` for all continuation turns inside one worker run

### 10.3 Streaming Turn Processing

The client processes app-server updates according to the targeted Codex app-server protocol until
the active turn terminates.

Completion conditions:

- Targeted-protocol turn completion signal -> success
- Targeted-protocol turn failure signal -> failure
- Targeted-protocol turn cancellation signal -> failure
- turn timeout (`turn_timeout_ms`) -> failure
- subprocess exit -> failure

Continuation processing:

- If the worker decides to continue after a successful turn, it SHOULD start another turn on the same
  live thread using the targeted protocol.
- The app-server subprocess SHOULD remain alive across those continuation turns and be stopped only
  when the worker run is ending.

Transport handling requirements:

- Follow the transport and framing rules of the targeted Codex app-server version.
- For stdio-based transports, keep protocol stream handling separate from diagnostic stderr
  handling unless the targeted protocol specifies otherwise.
- Bound buffered messages and pending requests. When the consumer cannot keep up, apply protocol
  backpressure if available; otherwise fail the attempt with `agent_process` rather than allowing
  unbounded memory growth.
- On shutdown or failure, cancel pending requests, close transport handles, terminate the process
  tree, and wait for confirmed exit within a bounded grace period.

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The app-server client emits structured events to the orchestrator callback. Each event SHOULD
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `codex_app_server_pid` (if available)
- OPTIONAL `usage` map (token counts)
- payload fields as needed

Important emitted events include, for example:

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_ended_with_error`
- `turn_input_required`
- `approval_auto_approved`
- `unsupported_tool_call`
- `notification`
- `other_message`
- `malformed`

### 10.5 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined.

Policy requirements:

- Each implementation MUST document its chosen approval, sandbox, and operator-confirmation
  posture.
- Approval requests and user-input-required events MUST NOT leave a run stalled indefinitely. An
  implementation MAY either satisfy them, surface them to an operator, auto-resolve them, or
  fail the run according to its documented policy.

Example high-trust behavior:

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session.
- Treat user-input-required turns as hard failure.

Unsupported dynamic tool calls:

- Supported dynamic tool calls that are explicitly implemented and advertised by the runtime SHOULD
  be handled according to their extension contract.
- If the agent requests a dynamic tool call that is not supported, return a tool failure response
  using the targeted protocol and continue the session.
- This prevents the session from stalling on unsupported tool execution paths.

Optional client-side tool extension:

- An implementation MAY expose a limited set of client-side tools to the app-server session.
- The core standardized tool is `report_outcome`, which accepts the Section 4.1.12 structure and is
  REQUIRED unless the selected agent protocol provides an equivalent schema-constrained terminal
  result.
- Workflow mutations SHOULD use narrow typed tools such as `request_state_transition`,
  `upsert_workpad`, and `request_merge`. These tools return policy decisions and do not expose raw
  credentials.
- Broad tools such as `linear_graphql` or `github_graphql` are compatibility extensions. They MUST
  be disabled by default, explicitly enabled per workflow, scoped to minimum authority, audited,
  and unavailable to reviewer roles that do not need mutation access.
- If implemented, supported tools SHOULD be advertised to the app-server session during startup
  using the protocol mechanism supported by the targeted Codex app-server version.
- Unsupported tool names SHOULD still return a failure result using the targeted protocol and
  continue the session.

`linear_graphql` extension contract:

- Purpose: execute a raw GraphQL query or mutation against Linear using Symphony's configured
  tracker auth for the current session.
- Availability: only meaningful when `tracker.kind == "linear"` and valid Linear auth is configured.
- Preferred input shape:

  ```json
  {
    "query": "single GraphQL query or mutation document",
    "variables": {
      "optional": "graphql variables object"
    }
  }
  ```

- `query` MUST be a non-empty string.
- `query` MUST contain exactly one GraphQL operation.
- `variables` is OPTIONAL and, when present, MUST be a JSON object.
- Implementations MAY additionally accept a raw GraphQL query string as shorthand input.
- Execute one GraphQL operation per tool call.
- If the provided document contains multiple operations, reject the tool call as invalid input.
- `operationName` selection is intentionally out of scope for this extension.
- Reuse the configured Linear endpoint and auth from the active Symphony workflow/runtime config; do
  not require the coding agent to read raw tokens from disk.
- Tool result semantics:
  - transport success + no top-level GraphQL `errors` -> `success=true`
  - top-level GraphQL `errors` present -> `success=false`, but preserve the GraphQL response body
    for debugging
  - invalid input, missing auth, or transport failure -> `success=false` with an error payload
- Return the GraphQL response or error payload as structured tool output that the model can inspect
  in-session.

User-input-required policy:

- Implementations MUST document how targeted-protocol user-input-required signals are handled.
- A run MUST NOT stall indefinitely waiting for user input.
- A conforming implementation MAY fail the run, surface the request to an operator, satisfy it
  through an approved operator channel, or auto-resolve it according to its documented policy.
- The example high-trust behavior above fails user-input-required turns immediately.

### 10.6 Timeouts and Error Mapping

Timeouts:

- `codex.read_timeout_ms`: request/response timeout during startup and sync requests
- `codex.turn_timeout_ms`: total turn stream timeout
- `codex.stall_timeout_ms`: enforced by orchestrator based on event inactivity

Error mapping (RECOMMENDED normalized categories):

- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `port_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + app-server client.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Start app-server session.
4. Forward normalized app-server events to the orchestrator through a bounded channel.
5. Require and validate exactly one structured terminal outcome.
6. Stop the complete process tree and release resources.
7. On any error, return a normalized failure class; the orchestrator decides whether retry is
   allowed.

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract

### 11.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

4. `create_comment(issue_id, body)` (RECOMMENDED)
   - Used by workflows that maintain a persistent workpad comment.

5. `fetch_issue_comments(issue_id)` (RECOMMENDED)
   - Used by readiness guards and workpad reconciliation.

6. `update_issue_comment(comment_id, body)` (RECOMMENDED)
   - Used to update the same persistent workpad comment in place.

7. `update_issue_state(issue_id, state_name)` (RECOMMENDED)
   - Used by protected transition guards to route issues to `Rework`, `Blocked`, `Human Review`,
     `Merging`, or another configured lane.

8. `fetch_readiness_snapshot(issue_id)` (RECOMMENDED for pull-request workflows)
   - Returns the linked pull request, checks, reviews, review threads, PR comments, and issue comments
     required by Section 12.

### 11.2 Query Semantics (Linear)

Linear-specific requirements for `tracker.kind == "linear"`:

- `tracker.kind == "linear"`
- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Candidate and issue-state refresh queries include issue labels. Required
  label filtering happens after normalization so refresh can observe label
  removal and stop or release existing work.
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination REQUIRED for candidate issues
- Page size default: `50`
- Network timeout: `30000 ms`

Important:

- Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types REQUIRED by this specification.

A non-Linear implementation MAY change transport details, but the normalized outputs MUST match the
domain model in Section 4.

### 11.3 Query Semantics (GitHub Issues + Projects v2)

GitHub-specific requirements for `tracker.kind == "github"`:

- Use GitHub Projects v2 as the workflow board.
- Use the configured Project single-select `Status` field as the issue workflow state source of truth.
- Use the configured Project single-select `Priority` field for dispatch ordering when present.
- Use GitHub Issues as the work item content source.
- Use native GitHub issue dependencies, especially `blockedBy`, for dependency gating.
- Use `gh` authentication or another documented GitHub auth source. Do not require a GitHub token to
  be stored in `WORKFLOW.md`.
- Candidate queries MUST include issue ID, number, title, body, state, URL, created/updated times,
  repository owner/name, labels, assignees, Project field values, and blockers.
- Candidate filtering MUST reject issues outside the configured repository unless the implementation
  explicitly supports multi-repository dispatch.
- GitHub issue comments SHOULD be readable and updateable so the workpad can be maintained in place.
- GitHub Project status updates SHOULD be implemented by resolving Project, field, item, and option
  IDs, then updating the Project item single-select field.
- Readiness snapshot queries SHOULD resolve the pull request that closes or is linked to the issue,
  then include latest head SHA, base ref, merge state, review decision, checks, reviews, unresolved
  review threads, top-level PR comments, and issue comments.

GitHub Project field requirements:

- `Status` and `Priority` field names are configurable.
- The configured `Status` field MUST contain every lane used by the workflow prompt.
- The default GitHub SDLC workflow uses: `Backlog`, `Todo`, `In Progress`, `Risk Review`,
  `Human Review`, `Merging`, `Rework`, `Blocked`, and `Done`.

### 11.4 Normalization Rules

Candidate issue normalization SHOULD produce fields listed in Section 4.1.1.

Additional normalization details:

- Label names are trimmed and lowercased.

- `labels` -> lowercase strings
- `blocked_by` -> derived from inverse Linear relations where relation type is `blocks`, or from
  GitHub `blockedBy` issue dependency nodes.
- `priority` -> integer only for numeric tracker priorities; named priorities map through
  `tracker.priority_order` when available.
- `priority_name` -> tracker-provided named priority when available.
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.5 Error Handling Contract

RECOMMENDED error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `missing_github_project_owner`
- `missing_github_project_number`
- `missing_github_repo`
- `github_cli_missing`
- `github_auth_missing`
- `github_project_scope_missing`
- `github_graphql_errors`
- `github_unknown_payload`
- `linear_api_request` (transport failures)
- `linear_api_status` (non-200 HTTP)
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.
- Readiness snapshot failure: route the protected transition to `Blocked` and record the reason in
  the workpad when the implementation owns transition routing.
- Comment update failure: fail only the operation that requires the comment; keep the scheduler alive.

### 11.6 Tracker Writes and Protected Transitions

Symphony Encore owns workflow mutations through its orchestrator and typed integration adapters.

- Agents request state transitions, comment/workpad updates, PR metadata changes, or merges as typed
  actions in their outcome or through narrow client-side tools.
- The orchestrator MUST validate the request against the pinned workflow snapshot, current tracker
  state, current target revision, applicable guards, and the agent role's authority.
- Approved mutations MUST be idempotent, audited, and associated with the originating attempt.
- The service MUST reject stale-revision writes and transitions that skip protected states.
- Review agents are read-only by default. Granting them mutation authority requires an explicit
  documented workflow rule.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Risk Review` or `Human Review`) rather than tracker terminal state `Done`.
- If a broad GraphQL compatibility tool is implemented, its mutation paths remain subject to the
  same policy checks and audit requirements; bypassing them is non-conforming.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template because the workflow prompt can provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

### 12.5 GitHub SDLC Workflow Contract (RECOMMENDED Extension)

The GitHub SDLC workflow is a concrete workflow prompt and tracker-write policy for GitHub Issues,
GitHub Projects v2, and pull requests. It is not required for a generic Symphony implementation, but
it captures the fork's current behavior and SHOULD be implemented by successors that target the same
operating model.

#### 12.5.1 Lanes

The workflow uses these Project `Status` lanes:

- `Backlog`: not dispatchable. Symphony MUST NOT modify issue content or start implementation.
- `Todo`: dispatchable. The worker SHOULD move the issue to `In Progress` before active work.
- `In Progress`: implementation lane.
- `Risk Review`: protected review lane. Symphony SHOULD verify readiness evidence before dispatching
  a review worker.
- `Human Review`: human decision lane for high uncertainty, high blast radius, policy-sensitive
  changes, weak evidence, or invalid fresh-review contracts.
- `Merging`: protected merge lane. Symphony SHOULD verify fresh-context correctness review evidence
  before dispatching merge handling.
- `Rework`: dispatchable targeted-fix lane.
- `Blocked`: non-dispatchable lane for missing auth, tools, permissions, external systems, or required
  evidence.
- `Done`: terminal lane.

Every pull request MUST pass through `Risk Review` before `Merging`; direct `In Progress` ->
`Merging` or `In Progress` -> `Done` transitions are invalid for this workflow.

#### 12.5.2 Persistent Workpad

For each issue, the worker SHOULD find or create exactly one active issue comment with the marker
header `## Codex Workpad`. The worker MUST update that comment in place for progress, plans,
acceptance criteria, validation, proof packets, guard results, and handoff notes.

The workpad SHOULD contain this structure:

````md
## Codex Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1. Parent task
  - [ ] 1.1 Child task

### Acceptance Criteria

- [ ] Criterion with evidence target

### Validation

- [ ] command or check name: result

### Proof Packet

- Issue: <tracker issue URL>
- PR: <PR URL>
- Head SHA: <full or short SHA>
- Base branch: <branch>
- Changed files: <count and key paths>
- Validation:
  - [ ] <command or check name>: <result>
- CI: <required checks summary or link>
- Acceptance criteria:
  - [ ] <criterion>: <evidence>
- Review comments: <none | summary of addressed items>
- Known risks: <none | concise bullets>
- Skipped checks: <none | check and reason>

### Fresh Context Correctness Review

```json
{
  "review_name": "fresh_context_correctness_review",
  "review_head_sha": "<current PR head SHA>",
  "review_status": "not_run",
  "findings": [],
  "reviewer_input_summary": [],
  "cost_control": {
    "max_findings": 5,
    "max_attempts": 1,
    "timeout_seconds": 600
  }
}
```

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````

Workers SHOULD copy issue-authored `Validation`, `Test Plan`, or `Testing` sections into the workpad
as required validation checklist items. Workers SHOULD record reproduction evidence before editing
code and SHOULD record final validation evidence before moving to `Risk Review`.

#### 12.5.3 Required Worker Discipline

When `codex.required_skills` includes a workflow skill such as `sdlc-symphony`, the worker SHOULD
record the skill and lane in the workpad before active work:

```text
Skill used: sdlc-symphony
Symphony lane: <current lane>
```

This marker is audit evidence, not the sole readiness gate. Symphony MUST prefer artifact evidence
from the PR, proof packet, checks, and reviews over ceremonial attestation when deciding whether to
dispatch `Risk Review` or `Merging`.

#### 12.5.4 PR Feedback Sweep

Before moving to `Risk Review`, the worker SHOULD gather top-level PR comments, inline review
comments, review summaries and states, and unresolved review threads.

Every actionable human or bot comment is blocking until the worker either changes code/tests/docs to
address it or posts a concrete pushback reply on the thread. The worker SHOULD update the workpad
with each feedback item and resolution.

#### 12.5.5 Protected Transition Guards

For `In Progress` -> `Risk Review`, Symphony SHOULD:

1. Fetch the linked PR readiness snapshot.
2. Fetch the workpad issue comment.
3. Parse the proof packet.
4. Confirm the proof packet PR number matches the linked PR.
5. Confirm the proof packet head SHA matches the current PR head SHA.
6. Confirm validation evidence exists.
7. Confirm configured required checks are complete with accepted conclusions.
8. Confirm the current review decision is not `CHANGES_REQUESTED`.
9. Confirm no unresolved review thread or configured actionable top-level PR comment remains.
10. Write a `Guard Result` to the workpad.
11. Allow dispatch only when the guard result is `allow`; otherwise route to `Rework` or `Blocked`.

For `Risk Review` -> `Merging`, Symphony SHOULD:

1. Fetch the linked PR readiness snapshot.
2. Parse the workpad's `Fresh Context Correctness Review` JSON.
3. Confirm `review_name == "fresh_context_correctness_review"`.
4. Confirm `review_head_sha` equals the current PR head SHA.
5. Confirm `review_status` is `passed` or `non_blocking_findings`.
6. Confirm required reviewer inputs include issue acceptance criteria, PR diff, changed files, factual
   check results, and relevant repo docs.
7. Confirm forbidden reviewer inputs exclude builder self-assessment, builder reasoning, self-review,
   and claims of correctness.
8. Confirm cost controls are at most five findings, one attempt, and 600 seconds.
9. Confirm no finding marked `blocking: true` remains.
10. Write a `Guard Result` to the workpad.
11. Allow dispatch only when the guard result is `allow`; otherwise route to `Human Review`, `Rework`,
    or `Blocked`.

Guard results use `requested_transition`, `result`, `reason_code`, `reason`, `next_lane`, and
`evidence`. Valid results are `allow`, `route_to_rework`, `route_to_human_review`, and
`route_to_blocked`.

#### 12.5.6 Risk Review, Human Review, Merging, and Rework

Risk Review SHOULD run a fresh-context correctness review using issue acceptance criteria, PR diff,
changed files, factual check results, linked PR comments/reviews, proof packet, and relevant repo
docs. It SHOULD exclude the builder's reasoning narrative, self-review, and claims of correctness.
It SHOULD return exactly one routing decision: `auto_merge_eligible`, `needs_human_review`,
`needs_rework`, or `blocked`.

Human Review is a waiting lane. Workers SHOULD poll for decisions and review updates, but MUST NOT
start new implementation work while the issue remains in `Human Review`.

Merging MUST use the repository landing procedure rather than direct ad hoc merge commands. Before
merge, the worker SHOULD verify that the PR is open, not draft, targets the expected base, matches the
reviewed head SHA, has green required checks, has no unresolved actionable review feedback, and has
valid fresh-context review evidence. After merge, the worker SHOULD watch staging or post-deploy
checks to a terminal state and move the issue to `Done` only after all deliverables and acceptance
criteria map to evidence.

Rework is targeted by default. The worker SHOULD preserve the existing PR, branch, and workpad when
the approach is sound. A full reset is appropriate only when the branch or PR is closed/unusable, the
implementation strategy is wrong, the workpad/proof packet is unrecoverable, or repeated guard
failures show targeted fixes are not converging.

### 12.6 Adaptive Compute Routing

Compute is selected per phase, not once for the whole issue.

Reference phase policy:

- Discovery, repository orientation, log collection, and deterministic evidence extraction SHOULD
  begin with the `economy` profile unless a risk floor raises them.
- Ordinary implementation SHOULD use `standard`.
- Security-sensitive work, data migrations, concurrency, ambiguous acceptance criteria,
  cross-package architecture, and public API design SHOULD use `deep`.
- The integrative review SHOULD use at least `standard`; high-risk changes use `deep`.
- Architecture/product adjudication SHOULD use `deep` because it depends on broad context and taste,
  not merely local defect detection.

Routing inputs MUST be observable facts such as changed paths, dependency graph, declared risk,
issue labels, diff size, test surface, prior failed attempts, security boundaries, schema changes,
and unresolved ambiguity. Routing MUST NOT depend only on the agent's self-reported confidence.

Escalation is appropriate when an attempt exposes new risk, contradicts evidence, exhausts its
context, repeats a failure, or cannot reconcile acceptance criteria. Escalation MUST preserve the
workspace but start a fresh thread with a factual handoff containing:

- goal and acceptance criteria
- current repository revision and changed files
- commands run and exact results
- decisions already fixed by policy or the user
- open findings and unresolved facts
- side effects already applied

The handoff MUST NOT include hidden reasoning, a claim that the work is correct, or instructions to
rubber-stamp the prior attempt.

### 12.7 Review Orchestration

Review proceeds in this order:

1. Run deterministic checks and assemble a shared evidence packet.
2. Run one independent integrative reviewer over the complete change and acceptance contract.
3. Evaluate deterministic specialist trigger rules.
4. If triggered, fan out up to `review.max_parallel_specialists` focused reviewers against the same
   revision and evidence packet.
5. Merge the union of evidence-backed findings, deduplicated by affected behavior and evidence.
6. Invoke one `deep` adjudicator only when findings materially conflict or their combined remedy
   creates an architectural trade-off.
7. Route once: accept, targeted rework, human input, or blocked.

Reference review depth:

- Tiny, low-risk change: deterministic checks plus the integrative reviewer.
- Normal change: integrative reviewer plus any triggered systems/security or architecture/product
  specialist.
- High-risk change: integrative reviewer plus both default specialists.

Reviewer independence requirements:

- A reviewer MUST run in a fresh thread and MUST NOT receive builder reasoning, self-review, or
  unsupported correctness claims.
- All reviewers inspect the same immutable target revision.
- Each specialist receives only the concern slice, evidence, and repository context needed for its
  assignment, plus enough full-change context to identify cross-boundary effects.
- Findings MUST identify affected behavior, severity, concrete evidence, and a proposed
  disposition. Unsupported stylistic preference is non-blocking.
- Correlated votes do not increase confidence. Majority vote, best-of-N verdict selection, and
  repeated identical reviewer prompts are non-conforming substitutes for concern decomposition.
- The coordinator MUST retain all unique blocking findings. An adjudicator may resolve conflicts but
  MUST cite evidence and may not erase an uncontested blocking finding without explaining why its
  premise is false.

The initial operating target is to reserve roughly 25-35 percent of agent cost for review and
repair. This is a calibration target, not a quota. Implementations SHOULD tune routing from measured
escape defects, false positives, rework cycles, latency, and cost per accepted issue. Sampled deep
audits MUST be used to estimate defects missed by cheaper routes.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
SHOULD return:

- `running` (list of running session rows)
- each running row SHOULD include `turn_count`
- `retrying` (list of retry queue rows)
- session and retry rows SHOULD include the tracker-provided issue URL when available
- `codex_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest coding-agent rate limit payload, if available)
- `routing`
  - selected logical profile, resolved model, reasoning effort, deterministic floor, routing rules,
    escalation count, and sampled-audit status for each attempt/reviewer
- `reviews`
  - reviewer roles, target revision, decisions, finding counts, conflicts, and adjudication result
- `persistence`
  - database health, schema version, lease-renewal health, and last successful checkpoint

RECOMMENDED snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 OPTIONAL Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is OPTIONAL and
implementation-defined.

If present, it SHOULD draw from orchestrator state/metrics only and MUST NOT be REQUIRED for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Agent events can include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

Humanized summaries of raw agent protocol events are OPTIONAL.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 SDLC Outcome Events (RECOMMENDED)

Implementations that run the GitHub SDLC workflow SHOULD emit lightweight JSON Lines outcome events
for local inspection and later aggregation. Events are for outcomes and costs, not large artifacts.

The default event file SHOULD live beside the main log as `sdlc_events.jsonl`. If the operator
configures a logs root, the event file SHOULD follow that root.

Every event SHOULD include these stable fields:

- `event_name`
- `issue_id`
- `issue_number`
- `pr_number`
- `old_state`
- `new_state`
- `result`
- `reason_code`
- `reason`
- `head_sha`
- `session_id`
- `worker_workspace`
- `timestamp`
- `token_usage`
- `config_snapshot_id`
- `compute_profile`
- `model`
- `reasoning_effort`
- `routing_reasons`
- `estimated_or_recorded_cost`

Events MAY include counters such as `turns`, `attempt`, and `runtime_seconds`. Event payloads MUST
NOT include prompt bodies, full diffs, secrets, private credentials, or other large artifacts.

Recommended event names:

- `issue_session_usage`
  - Emitted when an agent task finishes. Result: `recorded`.
- `compute_route_selected`
  - Emitted before an attempt or reviewer starts. Includes the deterministic floor, selected profile,
    and triggering rule identifiers.
- `compute_escalated`
  - Emitted when work moves to a fresh thread with a stronger profile.
- `run_outcome_recorded`
  - Emitted after the Section 4.1.12 outcome is validated and durably committed.
- `review_assignment_started`
  - Emitted for the integrative reviewer and each triggered specialist.
- `review_finding_recorded`
  - Emitted for evidence-backed findings without embedding large diffs or prompt bodies.
- `review_adjudication_result`
  - Emitted only when material reviewer conflict required adjudication.
- `readiness_guard_result`
  - Emitted when a guard evaluates `In Progress` -> `Risk Review` or `Risk Review` -> `Merging`.
  - Results: `allow`, `route_to_rework`, `route_to_human_review`, `route_to_blocked`.
- `fresh_context_review_result`
  - Emitted when the merge-entry guard consumes a fresh-context correctness review result.
  - Results: `passed`, `blocking_findings`, `non_blocking_findings`, `not_run`.
- `risk_review_result`
  - Emitted when a continuation poll observes an issue move out of `Risk Review`.
  - Results: `auto_merge_eligible`, `needs_human_review`, `needs_rework`, `blocked`.
- `rework_entered`
  - Emitted when an issue moves into `Rework`.
- `blocked_entered`
  - Emitted when an issue moves into `Blocked`.
- `merge_result`
  - Emitted when a continuation poll observes an issue move out of `Merging`.
  - Results: `merged`, `failed`.

Reason codes SHOULD be stable dot-separated strings. Recommended prefixes:

- `readiness.`
- `fresh_review.`
- `gate.<gate-name>.`
- `human_review.`
- `merge.`

### 13.8 OPTIONAL HTTP Server Extension

This section defines an OPTIONAL HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not REQUIRED for conformance.
- The implementation MAY serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API MUST be observability/control surfaces only and MUST NOT become REQUIRED for
  orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL)
  - Enables the HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
  - CLI `--port` overrides `server.port` when both are present.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- The `server` top-level key is owned by this extension.
- Positive `server.port` values bind that port.
- Implementations SHOULD bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.8.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document SHOULD depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.8.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "issue_url": "https://tracker.example/issues/MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "codex_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "codex_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/codex/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    MAY coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API design notes:

- The JSON shapes above are the RECOMMENDED baseline for interoperability and debugging ergonomics.
- Implementations MAY add fields, but SHOULD avoid breaking existing fields within a version.
- Endpoints SHOULD be read-only except for operational triggers like `/refresh`.
- Unsupported methods on defined routes SHOULD return `405 Method Not Allowed`.
- API errors SHOULD use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it SHOULD consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing coding-agent executable

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; can come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested and handled as failure by the implementation's documented policy
   - Subprocess exit
   - Stalled session (no activity)

4. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

6. `Persistence Failures`
   - Database unavailable or corrupt
   - Migration failure
   - Claim transaction or lease renewal failure
   - Durable outcome commit failure

7. `Policy and Review Failures`
   - Unsafe or stale side-effect request
   - Missing or malformed structured outcome
   - Missing required integrative review
   - Review target revision changed
   - Material reviewer conflict not adjudicated

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Classify using Section 7.6.
  - Retry only retryable classes and only within the pinned budget.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

- Persistence failures:
  - Stop new dispatch immediately.
  - Do not apply external mutations whose intent cannot first be committed durably.
  - Keep or terminate existing workers according to whether leases and outcomes can still be
    recorded safely; surface an operator-visible critical error.

### 14.3 Partial State Recovery (Restart)

Control-plane state is durable. Agent processes and in-memory protocol sessions are not assumed to
survive process restart.

After restart:

- Open attempts and leases are loaded before dispatch starts.
- Leases with verified live ownership remain unavailable; expired or unverifiable leases enter
  reconciliation and are never blindly resumed.
- Retry due times and budgets are restored from durable records; runtime timer handles are rebuilt.
- Attempts interrupted before a durable outcome are closed as `agent_process` failures and retried
  only when budget permits.
- Side-effect intents without completion receipts are reconciled using their idempotency keys.
- Tracker state, durable state, and workspace ownership are compared before any re-dispatch.
- Terminal workspace cleanup runs after claims have been reconciled.

The baseline SQLite database MUST live on local disk, not a network filesystem. The worker is the
sole database writer. The dashboard and API SHOULD read through the worker or a read-only connection
whose consistency limitations are documented.

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings).
- `WORKFLOW.md` changes are detected and re-applied automatically without restart according to
  Section 6.2.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations SHOULD state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations SHOULD state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- Coding-agent cwd MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.

RECOMMENDED additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.
- Resolve secrets at the narrow integration boundary that needs them. Do not persist resolved secret
  values in configuration snapshots, prompts, handoffs, workpads, review packets, or event logs.
- Agent and reviewer processes SHOULD receive scoped credentials rather than the orchestrator's full
  environment. Reviewer roles SHOULD be read-only by default.
- Tool results MUST be filtered for accidental credentials before they enter model context or durable
  logs.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running Codex agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
implementations SHOULD NOT assume that tracker data, repository contents, prompt inputs, or tool
arguments are fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening Codex approval and sandbox settings described elsewhere in this specification instead
  of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in Codex policy controls.
- Filtering which Linear issues, projects, teams, labels, or other tracker sources are eligible for
  dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Keeping broad GraphQL compatibility tools disabled; when explicitly required, narrowing them to
  the intended project and operation scope.
- Reducing the set of client-side tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.
- Treating issue text, PR comments, repository files, tool output, and fetched web content as
  untrusted instructions. Policy and system constraints MUST NOT be delegated to those inputs.
- Separating control-plane credentials from workspace credentials and using typed brokers for
  privileged actions.
- Pinning review and mutation actions to an immutable commit SHA or equivalent target revision.
- Recording tool authority, target scope, and policy decision for every privileged action.

The correct controls are deployment-specific, but implementations SHOULD document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  store = open_local_state_store()
  apply_schema_migrations_transactionally(store)
  acquire_single_writer_lock(store)
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    blocked: {},
    retry_attempts: {},
    completed: set(),
    codex_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    codex_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  reconcile_durable_attempts_leases_and_side_effects(store)
  rebuild_retry_timers_from_store(store)
  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)
  state = reconcile_blocked_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

```text
function reconcile_blocked_issues(state):
  blocked_ids = keys(state.blocked)
  if blocked_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(blocked_ids)
  if refreshed failed:
    log_debug("keep blocked issues claimed")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      cleanup_workspace(issue.identifier)
      release_claim(state, issue.id)
    else if issue.state in active_states:
      state.blocked[issue.id].issue = issue
    else:
      release_claim(state, issue.id)

  release blocked claims for any requested issue IDs no longer visible
  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  guard = enforce_pre_dispatch_guards(issue)
  if guard.result is not allow:
    if guard.next_lane exists:
      tracker.update_issue_state(issue.id, guard.next_lane)
    record_guard_result(issue, guard)
    return state

  config_snapshot = commit_effective_config_snapshot()
  route = select_compute_route(issue, phase="implementation", config_snapshot)
  durable_attempt = transactionally_acquire_lease_and_create_attempt(
    issue, attempt, config_snapshot, route
  )
  if durable_attempt failed:
    return state

  worker = spawn_worker(
    fn -> run_agent_attempt(issue, durable_attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    close_attempt(durable_attempt, failure_class="agent_process")
    return schedule_retry_if_allowed(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    codex_app_server_pid: null,
    last_codex_message: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

```text
function enforce_pre_dispatch_guards(issue):
  if issue.state == "Risk Review" and github_sdlc_workflow_enabled():
    snapshot = tracker.fetch_readiness_snapshot(issue.id)
    workpad = tracker.fetch_issue_comments(issue.id).find("## Codex Workpad")
    if snapshot failed or workpad missing:
      return route_to_blocked("readiness.github_fetch_failed")
    return evaluate_implementation_readiness(snapshot, parse_proof_packet(workpad.body))

  if issue.state == "Merging" and github_sdlc_workflow_enabled():
    snapshot = tracker.fetch_readiness_snapshot(issue.id)
    workpad = tracker.fetch_issue_comments(issue.id).find("## Codex Workpad")
    if snapshot failed or workpad missing:
      return route_to_blocked("fresh_review.missing_evidence")
    return evaluate_fresh_review_merge_readiness(
      snapshot,
      parse_fresh_context_correctness_review(workpad.body)
    )

  return allow()
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, durable_attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = app_server.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  config = load_pinned_snapshot(durable_attempt.config_snapshot_id)
  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(config.workflow_template, issue, durable_attempt, turn_number, max_turns)
    if prompt failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = app_server.run_turn(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {codex_update, issue.id, msg})
    )

    if turn_result failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
    if refreshed_issue failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  outcome = app_server.require_structured_outcome(session)
  if outcome invalid:
    app_server.stop_session(session)
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("invalid structured outcome", failure_class="agent_process")

  commit_outcome_and_side_effect_intents(durable_attempt, outcome)
  app_server.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)

  exit_with_outcome(outcome)
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, result, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if result contains valid outcome:
    state = apply_outcome_transition_and_approved_side_effects(result.outcome, state)
  else:
    failure = classify_failure(result)
    state = schedule_retry_if_allowed(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      failure_class: failure.class,
      error: failure.summary
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation SHOULD include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.8 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Valid reload creates an immutable configuration snapshot
- In-flight attempts retain their pinned snapshot while hot settings and future-attempt settings
  apply according to Section 6.2
- Restart-required changes are reported without partially applying
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when OPTIONAL values are missing
- `tracker.kind` validation enforces supported kinds (`linear`, `github`)
- `tracker.api_key` works for direct-token trackers (including `$VAR` indirection)
- GitHub tracker validation requires Project owner/number and repository owner/name
- `codex.required_skills` normalizes values and blocks dispatch when required skills are missing
- `readiness.required_checks` and `readiness.review_markers` reject blank values
- `$VAR` resolution works for tracker API key and path values
- `~` path expansion works
- `codex.command` is preserved as a shell command string
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)
- Logical compute profiles resolve through the active adapter and reject unsupported model/effort
  combinations
- Deterministic risk floors cannot be lowered by heuristic or model classification

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- OPTIONAL workspace population/synchronization errors are surfaced
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization and root containment invariants are enforced before agent launch
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and the configured tracker project
- Linear query uses the specified project filter field (`slugId`)
- GitHub query uses the configured Project v2 owner/number and Status/Priority fields
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are normalized from Linear inverse relations of type `blocks` or GitHub `blockedBy`
- Labels are normalized to lowercase
- GitHub Project status updates resolve field/item/option IDs and mutate the Project item status
- GitHub issue comments can be created, listed, and updated for workpad use
- GitHub readiness snapshots include linked PR, checks, reviews, review threads, PR comments, and
  issue comments
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Reconciliation with no running issues is a no-op
- A valid normal outcome maps to exactly one policy transition; continuation occurs only when
  explicitly required and budgeted
- A retryable abnormal exit increments the applicable budget and uses exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Claim acquisition and attempt creation are atomic and durable before process launch
- Lease renewal prevents concurrent workspace ownership; expired leases enter reconciliation
- Retry timers, budgets, and due times are rebuilt after restart
- Side-effect intents and receipts reconcile idempotently after interruption
- Missing or malformed structured outcomes cannot produce a success transition
- Every failure maps to one Section 7.6 class and non-retryable classes do not loop
- `no_progress` stops at `agent.max_no_progress_attempts`
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- Blocked issues remain claimed while the blocker is present and are reconciled on later ticks
- `In Progress` -> `Risk Review` guard routes stale/missing proof, failed checks, requested changes,
  and actionable comments to the configured next lane
- `Risk Review` -> `Merging` guard rejects stale, missing, invalid, or blocking fresh-context review
  evidence
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

### 17.5 Coding-Agent App-Server Client

- Launch command uses workspace cwd and invokes `bash -lc <codex.command>`
- Session startup follows the targeted Codex app-server protocol.
- Adapter startup rejects incompatible protocol/schema/capability combinations before execution
- Selected model and reasoning effort are pinned for the attempt
- Client identity/capability payloads are valid when the targeted Codex app-server protocol requires
  them.
- Policy-related startup payloads use the implementation's documented approval/sandbox settings
- Thread and turn identities exposed by the targeted protocol are extracted and used to emit
  `session_started`
- Request/response read timeout is enforced
- Turn timeout is enforced
- Transport framing required by the targeted protocol is handled correctly
- Bounded event buffering applies backpressure or fails safely under overload
- Cancellation, timeout, stall, and shutdown terminate and verify the full process tree
- For stdio-based transports, diagnostic stderr handling is kept separate from the protocol stream
- Command/file-change approvals are handled according to the implementation's documented policy
- Unsupported dynamic tool calls are rejected without stalling the session
- User input requests are handled according to the implementation's documented policy and do not
  stall indefinitely
- Usage and rate-limit telemetry exposed by the targeted protocol is extracted
- Approval, user-input-required, usage, and rate-limit signals are interpreted according to the
  targeted protocol
- If client-side tools are implemented, session startup advertises the supported tool specs
  using the targeted app-server protocol
- `report_outcome` or an equivalent schema-constrained terminal result is required and validates all
  Section 4.1.12 fields
- Narrow mutation tools enforce role authority, current tracker state, target revision, guard
  results, and idempotency keys
- If the `linear_graphql` client-side tool extension is implemented:
  - the tool is advertised to the session
  - valid `query` / `variables` inputs execute against configured Linear auth
  - top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session
- If the `github_graphql` client-side tool extension is implemented:
  - the tool is advertised to the session
  - valid `query` / `variables` inputs execute through the configured GitHub auth path
  - invalid arguments, missing auth, Project-scope failures, and transport failures return structured
    failure payloads

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior
- If SDLC outcome events are implemented, JSONL events include the stable fields from Section 13.7
  and omit prompts, diffs, secrets, and large artifacts
- Compute-route, escalation, outcome, review assignment, finding, and adjudication events include
  pinned profile/model/effort and routing reasons
- Database, schema, lease-renewal, and checkpoint health are operator-visible

### 17.7 CLI and Host Lifecycle

- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Adaptive Compute and Review

- Phase routing selects the expected profile for low-, normal-, and high-risk fixtures
- Risk floors cover security, migrations, concurrency, public APIs, cross-package architecture, and
  acceptance ambiguity
- A classifier can raise but cannot lower the deterministic floor
- Escalation starts a fresh thread and supplies only the structured factual handoff
- Every change receives one full-change integrative review
- Low-risk changes do not fan out specialists without a trigger
- High-risk fixtures trigger both default specialist slices
- Reviewers operate on the same immutable target revision and are read-only by default
- Findings are unioned and deduplicated; majority vote is never used
- Materially conflicting findings invoke one deep adjudication; uncontested blocking findings remain
- Sampled deep audits measure missed-defect rates for cheaper routes
- Evaluation fixtures record quality, escaped defects, false positives, cost, latency, and rework
  cycles so routing changes can be compared against a strong-model baseline

### 17.9 Real Integration Profile (RECOMMENDED)

These checks are RECOMMENDED for production readiness and MAY be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied by the selected tracker auth
  path, such as `LINEAR_API_KEY` for Linear or authenticated `gh` with Project scope for GitHub.
- Real integration tests SHOULD use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 REQUIRED for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Immutable per-attempt configuration snapshots with explicit hot, next-attempt, and restart-required
  reload categories
- Polling orchestrator as the sole writer of durable control-plane state
- Local transactional persistence for claims, leases, attempts, retries, outcomes, guard decisions,
  side-effect intents/receipts, and configuration snapshots
- Restart reconciliation across durable state, tracker state, workspace ownership, and live-process
  evidence
- Issue tracker client with candidate fetch + state refresh + terminal fetch
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Versioned coding-agent adapter with protocol/schema capability checks, bounded transport,
  backpressure, and verified process-tree cleanup
- Codex launch command config (`codex.command`, default `codex app-server`)
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Structured terminal outcome contract with deterministic routing for `completed`, `needs_rework`,
  `blocked`, `needs_input`, `no_progress`, and `failed`
- Failure taxonomy, retry budgets, no-progress budget, and bounded compute escalation
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Logical compute profiles, deterministic phase/risk floors, pinned model/effort per attempt, and
  fresh-thread escalation handoffs
- Mandatory independent integrative review, conditional specialist fan-out, evidence-union merge,
  and conflict-only adjudication
- Narrow typed mutation tools with policy checks and idempotent orchestrator-owned side effects
- Executable Core Conformance suite covering Sections 17.1 through 17.8
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface)

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.8 if shipped.
- `linear_graphql` and `github_graphql` compatibility extensions expose explicitly scoped raw access
  only when a workflow opts in and the same mutation policy/audit controls remain enforced.
- GitHub Issues + Projects v2 tracker adapter implements candidate fetch, state refresh, comments,
  Project status updates, and readiness snapshots.
- GitHub SDLC workflow extension implements persistent workpads, proof packets, PR feedback sweep,
  readiness guards, fresh-context review guards, and lane routing.
- SDLC outcome events are emitted to JSONL with the stable field schema in Section 13.7.
- Remote or distributed durable-workflow execution, if single-host SQLite and process ownership no
  longer meet measured reliability or scale requirements.

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.9 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (OPTIONAL)

This appendix describes a common extension profile in which Symphony keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

Extension config:

- `worker.ssh_hosts` (list of SSH host strings, OPTIONAL)
  - When omitted, work runs locally.
- `worker.max_concurrent_agents_per_host` (positive integer, OPTIONAL)
  - Shared per-host cap applied across configured SSH hosts.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
- The coding-agent app-server is launched over SSH stdio instead of as a local subprocess, so the
  orchestrator still owns the session lifecycle even though commands execute remotely.
- Continuation turns inside one worker lifetime SHOULD stay on the same host and workspace.
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, coding-agent executable, and any required auth or repository
  prerequisites.

### A.2 Scheduling Notes

- SSH hosts MAY be treated as a pool for dispatch.
- Implementations MAY prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an OPTIONAL shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch SHOULD wait rather than silently falling back to a
  different execution mode.
- Implementations MAY fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host SHOULD be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

- Remote environment drift:
  - Each host needs the expected shell environment, coding-agent executable, auth, and repository
    prerequisites.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists.
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations SHOULD distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host SHOULD reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.

## Appendix B. TypeScript Implementation Profile (RECOMMENDED for Encore)

This profile defines the first Encore implementation without making its libraries part of Core
Conformance.

Recommended repository layout:

```text
SPEC.md
apps/
  dashboard/        # Next.js operator UI
  worker/           # long-running Node.js orchestrator
packages/
  core/             # domain types, transition functions, routing, guards
  persistence/      # SQLite schema, migrations, repositories
  agents/           # versioned provider adapters and process control
  trackers/         # GitHub and Linear adapters
  observability/    # events, metrics, redaction, API projections
  testkit/          # conformance fixtures and fake adapters
```

Recommended baseline:

- Language/runtime: strict TypeScript on the current Node.js LTS line.
- Workspace/package manager: pnpm workspaces.
- Dashboard: Next.js. It reads projections and sends typed operator commands; it does not own agent
  processes, polling, leases, or retry timers.
- Worker HTTP/control surface: Fastify with Server-Sent Events for local live updates.
- Validation/config: Zod, a YAML parser, and LiquidJS-compatible strict template rendering.
- Persistence: SQLite on local disk, transactional migrations, foreign keys enabled, and one worker
  process as the sole writer.
- Integrations: Octokit for GitHub plus isolated provider adapters for other trackers.
- Logging: Pino-compatible structured logs with centralized redaction.
- Tests: Vitest for unit/contract/integration tests and Playwright for dashboard flows.

Process topology:

```text
GitHub/Linear ----> worker ----> coding-agent app server
                       |
                       +----> local SQLite
                       |
                       +----> typed read model / SSE ----> Next.js dashboard
```

The worker MUST remain correct when the dashboard is stopped. The dashboard MUST NOT access mutable
SQLite tables directly or invent state transitions; it consumes a typed read model and submits typed
commands to the worker.

The first implementation SHOULD use ordinary TypeScript transition functions and SQL transactions.
It SHOULD NOT adopt Temporal, LangGraph, or a distributed queue until measured requirements demand
multi-host ownership, durable remote timers, or workflow histories that exceed the single-writer
design. The boundaries in packages/core, packages/agents, and packages/trackers MUST make such a
replacement possible without changing the core behavior contract.

Provider model slugs MUST live in deployment configuration or the active agent adapter. Workflow
policy refers only to logical compute profiles. This avoids making the specification stale when
providers add, rename, or retire models.

The TypeScript profile is conformant only when it passes the applicable Section 17 suite, including
crash/restart tests, adapter-contract fixtures, routing evals, and review-orchestration tests.

## Appendix C. Fork Capability Delta

The upstream `openai/symphony` specification is primarily a language-agnostic scheduler contract with
a Linear-compatible tracker profile. This fork adds product and workflow behavior that should be
preserved in successor implementations.

Capabilities added by this fork:

- GitHub Issues + GitHub Projects v2 tracker mode.
- GitHub Project `Status` as the workflow lane source of truth.
- GitHub Project `Priority` dispatch ordering.
- GitHub native `blockedBy` dependency gating.
- GitHub issue comment create/read/update operations.
- GitHub Project status mutation for guarded routing.
- GitHub linked-PR readiness snapshots covering checks, reviews, review threads, PR comments, and
  issue comments.
- `github_graphql` dynamic tool for in-session GitHub GraphQL access.
- Configurable required labels and assignee routing for pilot safety.
- `codex.required_skills` preflight and repo/Codex/agent skill discovery.
- Safer default Codex approval and sandbox policy, including workspace-rooted `workspaceWrite`
  defaults.
- Persistent `## Codex Workpad` comment as the durable issue handoff artifact.
- Workpad environment stamp, plan, acceptance criteria, validation, proof packet, fresh-context
  correctness review, guard result, notes, and confusions.
- Required mirroring of issue-authored validation or test-plan sections into the workpad.
- Mandatory PR feedback sweep before `Risk Review`.
- Protected `In Progress` -> `Risk Review` readiness guard.
- Protected `Risk Review` -> `Merging` fresh-review guard.
- `Risk Review`, `Human Review`, `Merging`, `Rework`, and `Blocked` lane semantics.
- Targeted rework policy with explicit full-reset conditions.
- SDLC outcome JSONL events for session usage, readiness guard results, fresh-context review results,
  risk-review routing, blocked/rework entry, and merge outcomes.
- Optional HTTP/dashboard surface backed by orchestrator state.

Encore v2 adds these requirements over the fork baseline:

- Durable single-writer control plane with transactional claims, leases, retries, attempt history,
  outcomes, configuration snapshots, and side-effect receipts.
- Explicit restart reconciliation across the database, tracker, workspaces, and process evidence.
- Immutable per-attempt configuration and categorized hot/next-attempt/restart-required reloads.
- Required structured run outcomes and factual fresh-thread handoffs.
- Normalized failure taxonomy with bounded retries, no-progress limits, and compute escalations.
- Versioned agent adapters with capability negotiation, schema compatibility, bounded buffering,
  backpressure, and full process-tree cleanup.
- Orchestrator-owned guarded mutations through narrow typed tools; raw GraphQL is opt-in
  compatibility behavior.
- Logical model/effort profiles, deterministic risk floors, phase-specific routing, escalation, and
  sampled deep audits.
- Mandatory integrative review, conditional systems/security and architecture/product specialists,
  evidence-union findings, and conflict-only adjudication without majority voting.
- Stronger secret isolation, prompt-injection boundaries, immutable revision pinning, and privileged
  action auditing.
- Executable conformance coverage for durability, routing quality, review behavior, adapter drift,
  and recovery—not only happy-path orchestration.
- Side-by-side implementation path where `elixir/` remains the reference implementation while
  `typescript/` is developed toward conformance.
