# Symphony Encore implementation status

Last updated: 2026-07-13

This ledger tracks the implementation of `SPEC.md`, `TECH_STACK.md`, and `CICD.md`. A checked item
means that the named proof exists in this repository and has passed its canonical verification
command. A green but narrower test does not complete a broader item.

## Current state

- Branch target: `feat/symphony-encore-core`.
- Current milestone: workflow runtime integration, container, and canonical delivery pipeline.
- Canonical gate: `make verify` is implemented; a current full local run is pending listener and
  Docker availability.
- Pull request: not opened yet.
- Core Conformance: not achieved.
- Real Integration Profile: not run.

## Specification coverage

| ID | Requirement area | Status | Required proof |
|---|---|---|---|
| S01 | Design principles and authority boundaries | In progress | Acyclic inward package graph, forbidden domain dependencies, durable mutation envelopes, and provider authority tests pass; the complete sole-writer orchestration path remains pending |
| S02 | Components and provider-independent interfaces | In progress | Inward workspace graph plus tracker, repository-hosting, and agent adapter interfaces pass; provider implementations pending |
| S03 | Complete durable domain model | In progress | Strict schemas and eleven checksummed SQLite migrations cover every Section 3 record, durable startup failures, the active-synthesis invariant, and claimed workspace checkout provenance; repository mappers beyond normalized issues remain pending |
| S04 | Change classification and proportional process | In progress | Pure staged/upward policy, durable sequential and replay-safe agent-submitted Plan revisions, exact acceptance-criterion coverage, canonical unique repository-path validation, internally consistent file/line estimates, configured trivial/risk-path matching, first authoritative Plan classification with provisional floors, atomic `validated` Plan plus Attempt-class commit, crash-safe `PLAN.md` projection, a session-binding-gated Codex tool decision, action-before-Plan rejection, enforced unapproved high-risk `plan_ready` termination, approved high-risk Plan action/completion gating with approval supersession on revision, validated high-risk Plan recovery plus independent fresh-context Plan-review planning/execution and atomic approve/reject routes with a rejected-revision cap, and deep approved/revision implementation-continuation planning/execution with revision-before-action enforcement pass; configured repository-scope validation and post-diff upward reclassification remain pending |
| S05 | Issue and SystemJob lifecycle | In progress | Lane policy, deterministic eligibility/candidate ordering, a serialized/coalesced periodic/immediate scheduler with production start/stop lifecycle, exact reconciliation-first poll ordering, complete paginated candidate/revision ingestion with atomic first-observation/external-lane history, slot- and claim-gated default candidate scheduling, preflight-first initial attempt planning, canonical initial issue dispatch records with exact provider authority, persistence-marked intents, revision-required receipt-gated issue launch with synchronized durable issue state, receipt-ordered workspace/session composition, atomic live-session/process binding, background stream consumption, settled pre-session launch failure, composed launch/consume/close lifecycle, thrown-stream process termination plus durable failure closure, durable implementation outcome/normalized-stream-failure closure, terminal claim release, reason-CAS `Ready` continuation dispatch with atomic next-Attempt/lease/budget reservation, fresh-context Plan-review and integrative-review continuation planning plus charged launch/consume/close lifecycles, atomic Plan-review and integrative Review Record outcome claims, durable `plan_review_required`, `implementation_after_plan_approval`, `plan_revision_required`, `independent_verification_required`, `review_required`, and `review_coordination_required` pickup independent of tracker candidates, approved/revision implementation-continuation execution, typed completed-target verification, atomic pass/rework claim routing, approved standard ReviewSet-to-`pull_request_required` routing, and deterministic high-risk missing-specialist routing, fail-closed running identity/slot/claim reads, complete paginated tracker refresh plus default main reconciliation assembly, atomic issue and tracker-free SystemJob dispatch/closure, bounded issue/repair outcome routing, and running-attempt reconciliation ordering pass; downstream provider lane/review actions, uncertain pre-launch intent recovery, specialist execution/adjudication, and remaining Ready-reason scheduling remain pending |
| S06 | Workspace isolation, hooks, and independent verification | In progress | Linux/WSL containment, full process-group termination, non-login hooks, actual workspace-HEAD resolution, production sandbox verification with bounded content-addressed evidence and exact config/command/environment/revision identity, atomic pass-to-review/failure-to-rework routing, explicit acknowledged `none` execution, stable ownership, startup quarantine, replay-safe repository/base-SHA/checkout-method/local-branch provenance bound to the active claim, provenance-gated startup ownership, GraphQL-resolved GitHub default-SHA checkout through credential-scoped argv-only `gh` plus credential-free local `git`, post-clone containment and revision verification, `after_create`-before-provenance crash ordering with failed-checkout removal, durable checkout reuse, receipt-gated production workspace preparation, per-attempt `before_run`, scrubbed worker launch state, production scheduler wiring, partial-clone cleanup, and containment-checked post-commit terminal cleanup with best-effort `before_remove` pass; macOS remains pending |
| S07 | Token and USD budget enforcement | In progress | Replay, bounded chronological same-role/profile usage history, production initial-attempt, Plan-review, and integrative-review history estimates, conservative selected-model pricing, deterministic attempt/issue/fleet token and conditional USD ledger preparation, hot-limit versioning with preserved accounting/adjustments, atomic scheduler/continuation dispatch reservations plus consumption-driven actual or zero-use launch-failure settlement, atomic absolute Usage Samples with replayable deltas/cost and synchronized live Attempt totals, priced cached-input calculation, and store-before-cancel per-attempt token/USD stream caps pass; rolling-window expiry and top-ups remain pending |
| S08 | Compute routing | In progress | Configured role/class profiles, strict deterministic-predicate parsing, ordered risk floors, provisional issue-attempt route selection and pinning, production scheduler plus economy Plan-review and standard integrative-review planning integration, upward-only heuristics, and escalation caps pass; complete production fact extraction remains pending |
| S09 | Review coordination and immutable ReviewSets | In progress | Role contracts, ordinary ReviewSet policy, independent high-risk Plan-review preflight/economy execution/result routing, durable approved-Plan implementation gating, persisted review-result-backed implementation handoffs, passing-verification target recovery, deterministic clean-worktree/diff/line-count checks, normalized content patch identity, bounded repository-rule collection, fresh-context standard integrative-review planning/execution, typed immutable-SHA result validation, atomic Review Record persistence, partial-review coordination routing, wrong-SHA fail-closed behavior, durable complete-set recovery, missing/duplicate reviewer rejection, no-voting decision composition, atomic standard-class ReviewSet plus aggregate claim routing, exact specialist-config validation, deterministic fact/path/size trigger selection, and ordered missing-specialist Ready routing pass; specialist execution, finding deduplication/adjudication, and high-risk ReviewSet completion remain pending |
| S10 | Git, pull requests, and serialized merge queues | In progress | Authorized intent/receipt durability and revision-pinned GitHub repository-hosting operation boundary pass; concrete Git transport and merge queues remain pending |
| S11 | Human questions, approvals, notifications, and controls | In progress | Authenticated reads, a recovery-gated, CSRF-bound, capability/version/idempotency/audit protected configuration mutation, and atomic Plan-review needs-input OperatorQuestion plus ParkedWork creation pass; remaining mutation resources and answer handling remain pending |
| S12 | Lessons, synthesis, and saturation | In progress | Deterministic interval/operator triggering, supervised deep routing, one-active-job SQLite enforcement, lesson citation, rule/prompt saturation, and completed-issue decay policies pass; lesson capture, attempt dispatch, review, and merge integration remain pending |
| S13 | Failure classification, retry, and restart recovery | In progress | Failure routing, intent reconstruction, interrupted closure with latest durable or factual first-attempt handoff, atomic zero-usage launch-failure closure/settlement, atomic post-shutdown reconciliation closure/settlement/claim routing, verified Linux tree termination, workspace recovery, production recovering-to-ready startup, operator-store corruption shutdown, orderly durable stop, a first-failure persistence safety latch that distinguishes provider refresh from observation-write failure, typed claim reconstruction, CAS lease renewal, retry-delay rebuilding, parked cursor/predicate rehydration, default candidate plus durable Plan-review/implementation-continuation/verification/integrative-review Ready dispatch, and terminal/lane/eligibility/stall reconciliation in the default process pass; parked-work integration and remaining continuation recovery remain pending |
| S14 | Durable logs, events, quality metrics, and retention | In progress | Append-only Event Records, restart replay, authenticated paging, and abortable cursor-based SSE pass; logs, quality, retention, and tombstones pending |
| S15 | Security, authentication, bootstrap, and sandboxing | In progress | Loopback-only exact-hash bootstrap validates and snapshots the full workflow candidate, atomically creates matching local authority, and disables dispatch and mutations until completion; operator-empty non-pristine stores now terminate recorded processes, accept only provider-observed receipts, record a durable startup failure, and exit without replacing authority; concrete provider reconciliation wiring and macOS posture remain pending |
| S16 | GitHub tracker and repository-hosting adapters | In progress | Authenticated bounded `gh api` GraphQL transport, concrete Projects v2 candidate/state/comment/lane operations, native-terminal and priority normalization, fail-closed nested pagination, viewer-owned comment upserts, normalized complete PR snapshots, revision-pinned operation authority, and exact default-branch workspace checkout pass; publish/update/merge Git transport and project-schema repair remain pending |
| S17 | Codex app-server adapter | In progress | Installed Codex-generated bindings now anchor a bounded stdio client with initialize/thread/turn sequencing, live paginated catalog discovery, a pinned v2 protocol-shape digest, fail-closed default-model validation, catalog-derived logical profiles, explicit unpriced operation, skills, typed `report_result`/`submit_plan`, lossless normalized Plan/session/action/usage/terminal/turn events, schema rejection, unsupported-tool replies, asynchronous orchestrator Plan acceptance/rejection before tool continuation, request/read/turn/stall limits, process-group shutdown, first-event session identity validation, persistence-before-running process/thread/turn binding with failure-latched cancellation, durable remaining-stream ordering, role/Plan schema validation, terminal-result-before-turn enforcement, confirmed-exit token/USD cap termination, and production attempt outcome closure pass; approval/error breadth, salvage, and real subprocess proof remain pending |
| S18 | `WORKFLOW.md`, validation, reload, and overrides | In progress | Complete key catalog, precedence/provenance, semantic validation, strict safe prompt rendering across every documented context root, serialized hash-based file detection, last-known-good rejection, durable accepted/rejected reload events, restart-bound pending state, durable overrides, exact-candidate acknowledgment, immutable snapshots, trusted path loading, startup integration, and in-memory prompt propagation into initial production launches pass; live scheduler refresh after accepted workflow reload plus full API/UI candidate and acknowledgment integration remain pending |
| S19 | Core and real-integration conformance reports | In progress | `make conformance` runs the fast deterministic gate, emits an exact-revision machine-readable partial report, and fails rather than claiming incomplete Core coverage; complete matrix and redacted real profile remain pending |

## Technology-stack coverage

| ID | Requirement area | Status | Required proof |
|---|---|---|---|
| T01 | Node 24 Active LTS, pnpm workspace, strict TypeScript, one lockfile | Implemented | Pinned files, frozen install, typecheck, and production workspace imports resolve to emitted JavaScript |
| T02 | Inward, acyclic package graph | Implemented | Repository policy tests and lint gate |
| T03 | React/Vite/TanStack/shadcn/Tailwind operator UI | In progress | Authenticated responsive React/Vite console, exact-hash first-run view, TanStack Router/Query/Table operations and settings slice, production build, Chromium flow, and Fastify static delivery pass; current bootstrap browser run, durable history/live-log/API breadth, and component-system completion pending |
| T04 | Fastify, TypeBox, OpenAPI, generated client, and SSE cursors | In progress | Typed loopback bootstrap, login, read, and configuration-mutation routes, structured errors, OpenAPI/client drift gates, durable SSE IDs, replay, EventSource requests, SPA fallback isolation, and restrictive response headers pass; remaining API resources pending |
| T05 | Pure domain transitions and transactional orchestration | In progress | Pure policies plus atomic dispatch, closure, authorized intent/receipt, and receipt-confirmed stage transitions pass |
| T06 | SQLite WAL, better-sqlite3, Kysely, immutable migrations | In progress | Eleven checksummed migrations cover durable entities, evidence, append-only events, operators, sessions, startup failures, active synthesis, and workspace checkout provenance; WAL, atomic transactions, configuration history, and restart round-trips pass |
| T07 | Pino structured logging and redaction | Implemented | Shared Pino/Fastify lifecycle, stable bindings, NDJSON, and recursive fixed-field secret-redaction tests pass |
| T08 | Vitest, Playwright, Biome, TypeScript, real boundary tests | In progress | Root and package-local Vitest, Biome, TypeScript, generated-contract drift checks, real subprocess boundaries, and production-build Playwright flow pass; full boundary matrix pending |
| T09 | Linux, macOS, WSL development commands and signal handling | In progress | One-terminal source supervision, sibling-failure teardown, process-group signal escalation, Linux/WSL sandboxing, confirmed tree exit, SIGINT/SIGTERM idempotence, real SIGTERM production smoke, and a documented Windows-host/WSL release check pass; macOS runtime boundary and current WSL release evidence pending |
| T10 | Node distribution and non-root multi-stage container | In progress | Built Node entrypoint, safe runtime options, one-port API/UI, health/readiness, durable lifecycle, production-only deploy layout, digest-pinned multi-stage image, numeric non-root user, read-only-root smoke harness, volumes, Tini, loopback bootstrap, restart, and durable-stop checks are implemented; Docker execution is pending because Docker is unavailable locally |
| T11 | Exact dependency/toolchain pinning and update policy | In progress | Exact manifests/lockfile/toolchain, digest- and commit-pinned delivery inputs, and separate pnpm/Actions/Docker Dependabot schedules pass; built-image dependency inventory proof pending |
| T12 | Deferred technologies remain absent | Implemented | Repository policy rejects deferred application, server, queue, database, workflow, and transport dependencies |

## CI/CD coverage

| ID | Requirement area | Status | Required proof |
|---|---|---|---|
| D01 | Protected `main`, squash policy, stable required checks | Not started | Repository ruleset inspection |
| D02 | PR, merge-group, and `main` canonical verification | In progress | Commit-pinned `ci.yml` covers all three events; first successful remote runs pending |
| D03 | Least-privilege workflow permissions and untrusted-code isolation | Implemented | Read-only untrusted jobs, credential-free checkout, no trusted cache/publication path, pinned actionlint, and pinned pedantic offline zizmor with zero findings |
| D04 | Policy, docs, lockfile, graph, and title gates | In progress | Stable `ci / required`, repository policy, generated drift, Markdown, lockfile, graph, and Conventional Commit PR-title gates exist; remote required-check proof pending |
| D05 | Dependency, action, image, and secret review | In progress | Immutable action/base pins plus dependency review, Gitleaks, and Trivy jobs exist; first successful remote evidence pending |
| D06 | Static, unit, contract, integration, build, E2E, and image jobs | In progress | Local static/unit/contract/build, emitted-runtime integration, and production-build Playwright targets pass; Linux/macOS jobs plus a non-root read-only container bootstrap/restart/persistence smoke are authored; remote workflow proof pending |
| D07 | Verified immutable artifacts, SBOM, provenance, and checksums | In progress | Protected-main publication is gated behind the stable required job and emits a commit-tagged GHCR image, Node archive, image/distribution CycloneDX SBOMs, checksums, manifest, BuildKit attestations, and signed GitHub provenance; first successful remote publication pending |
| D08 | Tag promotion without rebuilding | In progress | Immutable semantic-tag validation, protected-main artifact lookup, checksum/provenance verification, security rescan, digest-preserving `imagetools create`, and GitHub release evidence are authored and policy-tested; first remote promotion pending |
| D09 | Dependabot for pnpm, Actions, and Docker | Implemented | Valid weekly npm, GitHub Actions, and Docker updater configuration with major toolchain updates kept visible |
| D10 | Fast staged-file hooks and optional pre-push verification | Implemented | Husky/lint-staged operate on selected staged files; staged policy rejects whitespace, conflict markers, binaries, and large blobs; checksum-pinned Gitleaks rejects a synthetic staged secret with redacted output; Conventional Commit subjects and documented bypass policy pass |
| D11 | Cache, artifact, retention, flake, and rollback policy | In progress | No cross-trust dependency cache, 14-day failed Playwright artifact retention, operator runbooks, WSL smoke procedure, and verified-digest rollback policy exist; publication and environment-specific rollback proof pending |
| D12 | Complete stable Make command interface | In progress | Setup, supervised dev, format, lint, typecheck, test, build, start, verify-fast, emitted-runtime test-integration, production-build test-e2e, image, and honest conformance-report targets exist; image execution and complete Core conformance remain pending |

## Core conformance matrix

The test IDs below correspond in order to the bullets in `SPEC.md` Section 19.2.

- [ ] `C-WF-01` Workflow parsing, strict templates, reload, near-miss rejection, and warnings.
- [ ] `C-WF-02` Default, workflow, and durable override precedence across restart.
- [ ] `C-WF-03` Bootstrap keys are read-only and cannot be overridden.
- [ ] `C-WF-04` Bootstrap keys are rejected in repository configuration.
- [ ] `C-WF-05` Exact-candidate acknowledgment and reload-boundary behavior.
- [ ] `C-WF-06` Pristine bootstrap and non-pristine fail-closed recovery; concrete provider receipt lookup wiring remains pending.
- [ ] `C-WF-07` Skill and adapter preflight before charging an attempt.
- [ ] `C-DUR-01` Atomic claim, attempt, reservation, and receipt-confirmed stage transition.
- [ ] `C-DUR-02` Lease modes and complete restart reconstruction.
- [x] `C-DUR-03` Process ownership verification and interrupted-attempt closure.
- [ ] `C-DUR-04` Intent reconciliation and authorization-envelope rejection matrix.
- [ ] `C-DUR-05` Persistence failure stops dispatch, mutations, and unsafe workers.
- [ ] `C-PLAN-01` Role result validation and independent verification records.
- [ ] `C-PLAN-02` Plan coverage, staged classification, and upward-only reclassification.
- [ ] `C-PLAN-03` Every class, plan-review route, cap, and conditional role-result field.
- [ ] `C-PLAN-04` One pinned model/profile per attempt and accounted salvage.
- [ ] `C-BUD-01` Replay-safe absolute usage and all durable aggregates.
- [ ] `C-BUD-02` Reservations, fan-out, top-ups, release, and overrun behavior.
- [ ] `C-BUD-03` Priced and unpriced scope enforcement plus audited reset/resume.
- [ ] `C-BUD-04` Durable elapsed and per-stage time across restart.
- [ ] `C-REV-01` Current checks, threads, reviews, and supervised approval gate.
- [ ] `C-REV-02` Complete immutable ReviewSets and no-voting/adjudication invariants.
- [ ] `C-REV-03` Per-repository serialization and exact patch-identity carry-forward.
- [ ] `C-REV-04` Repair cycle, escaped defect, demotion, notification, and queue independence.
- [ ] `C-REV-05` Reproducible sampled audits and supervised synthesis SystemJobs.
- [ ] `C-UI-01` Dashboard, history, and settings render only Control API state.
- [ ] `C-UI-02` Complete durable history and links remain visible after restart.
- [ ] `C-UI-03` Scrubbed agent actions and bounded output remain stage-grouped after restart.
- [x] `C-UI-04` Settings mutations show only committed state and retain failed input.
- [ ] `C-UI-05` Authentication, authorization, CSRF, versioning, idempotency, and audit.
- [ ] `C-UI-06` Hostile content escaping, safe links, and working Content Security Policy.
- [ ] `C-UI-07` Indefinite history and protected, audited retention tombstones.
- [ ] `C-SEC-01` Resolved workspace write boundary, quarantine, ownership, and tree termination.
- [ ] `C-SEC-02` Credential-free allowlisted subprocess environments.
- [ ] `C-SEC-03` All privileged mutations use the correct typed authority path.

## Verification log

| Date | Revision | Command | Result | Scope |
|---|---|---|---|---|
| 2026-07-13 | `af70136` | repository inspection only | No implementation existed | Baseline |
| 2026-07-13 | working tree | `make verify-fast` | 16 tests; lint and typecheck passed | Foundation |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Foundation |
| 2026-07-13 | working tree | `make verify-fast` | 90 tests; lint and typecheck passed | Domain, contracts, persistence, workflow |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Domain, contracts, persistence, workflow |
| 2026-07-13 | working tree | `make verify-fast` | 119 tests; lint and typecheck passed | Configuration, snapshots, acknowledgment, compute routing |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Configuration, snapshots, acknowledgment, compute routing |
| 2026-07-13 | working tree | `make verify-fast` | 139 tests; lint, generated-contract drift, and typecheck passed | Durable schemas, normalized adapter contracts, pagination |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Durable schemas, normalized adapter contracts, pagination |
| 2026-07-13 | working tree | `make verify-fast` | 142 tests; lint, generated-contract drift, and typecheck passed | Complete entity tables and issue restart repository |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Complete entity tables and issue restart repository |
| 2026-07-13 | working tree | `make verify-fast` | 147 tests; lint, generated-contract drift, and typecheck passed | Authorized intents, idempotency, reconciliation, receipt-confirmed stages |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Authorized intents, idempotency, reconciliation, receipt-confirmed stages |
| 2026-07-13 | working tree | `make verify-fast` | 150 tests; lint, generated-contract drift, and typecheck passed | ServiceRun recovery sequencing and shared status contract |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | ServiceRun recovery sequencing and shared status contract |
| 2026-07-13 | working tree | `make verify-fast` | 156 tests; lint, generated-contract drift, and typecheck passed | Failure classification, bounded retries, backoff, and fail-closed routes |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Failure classification, bounded retries, backoff, and fail-closed routes |
| 2026-07-13 | working tree | `make verify-fast` | 158 tests; lint, generated-contract drift, and typecheck passed | Interrupted attempt closure, ownership evidence, settlement, and requeue |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Interrupted attempt closure, ownership evidence, settlement, and requeue |
| 2026-07-13 | working tree | `make verify-fast` | 166 tests; lint, generated-contract drift, and typecheck passed | Workspace containment, credential scrubbing, Linux/WSL write boundary |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Workspace containment, credential scrubbing, Linux/WSL write boundary |
| 2026-07-13 | working tree | `make verify-fast` | 167 tests; lint, generated-contract drift, and typecheck passed | Sandboxed timeout and process-group termination |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Sandboxed timeout and process-group termination |
| 2026-07-13 | working tree | `make verify-fast` | 176 tests; lint, generated-contract drift, and typecheck passed | Non-login hooks, independent verifier, durable bounded evidence, exact guard lookup |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Non-login hooks, independent verifier, durable bounded evidence, exact guard lookup |
| 2026-07-13 | working tree | `make verify-fast` | 185 tests; lint, generated-contract drift, and typecheck passed | Stable claimed workspace ownership, quarantine, and startup readiness gate |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Stable claimed workspace ownership, quarantine, and startup readiness gate |
| 2026-07-13 | working tree | `make verify-fast` | 196 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Fastify liveness/readiness, authenticated state read, generated API contract and client |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Fastify liveness/readiness, authenticated state read, generated API contract and client |
| 2026-07-13 | working tree | `make verify-fast` | 204 tests; lint, contract/OpenAPI/client drift, and typecheck passed | SQLite-backed control state and append-only resumable Event Record cursors |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | SQLite-backed control state and append-only resumable Event Record cursors |
| 2026-07-13 | working tree | `make verify-fast` | 208 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Authenticated event paging, generated cursor client, structured 422 validation |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Authenticated event paging, generated cursor client, structured 422 validation |
| 2026-07-13 | working tree | `make verify-fast` | 214 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Abortable live event following, safe SSE framing, resume cursor, generated EventSource request |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Abortable live event following, safe SSE framing, resume cursor, generated EventSource request |
| 2026-07-13 | working tree | `make verify-fast` | 217 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Linux ownership inspection, TERM/KILL group escalation, and confirmed tree exit |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Linux ownership inspection, TERM/KILL group escalation, and confirmed tree exit |
| 2026-07-13 | working tree | `make verify-fast` | 220 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Ordered startup termination, atomic interrupted closure, quarantine, and readiness |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Ordered startup termination, atomic interrupted closure, quarantine, and readiness |
| 2026-07-13 | working tree | `make verify-fast` | 235 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Atomic pristine bootstrap, local password verification, hash-only sessions, login cookie, and same-origin CSRF |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Atomic pristine bootstrap, local password verification, hash-only sessions, login cookie, and same-origin CSRF |
| 2026-07-13 | working tree | `make verify-fast` | 239 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Recovery-gated configuration mutation with capability, CSRF, version, idempotency, validation, and audit |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Recovery-gated configuration mutation with capability, CSRF, version, idempotency, validation, and audit |
| 2026-07-13 | working tree | `make verify-fast` | 242 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Shared Pino/Fastify logging, stable bindings, and recursive secret redaction |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Shared Pino/Fastify logging, stable bindings, and recursive secret redaction |
| 2026-07-13 | working tree | `make verify-fast` | 252 tests; lint, contract/OpenAPI/client drift, and typecheck passed | GitHub tracker normalization, pagination fail-closed, revision recheck, provider authorization, and `/proc` exit-race handling |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | GitHub tracker normalization, pagination fail-closed, revision recheck, provider authorization, and `/proc` exit-race handling |
| 2026-07-13 | working tree | `make verify-fast` | 258 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Bounded allowlisted `gh api` GraphQL subprocess, provider request IDs, and typed failure mapping |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Bounded allowlisted `gh api` GraphQL subprocess, provider request IDs, and typed failure mapping |
| 2026-07-13 | working tree | `make verify-fast` | 269 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Authenticated responsive console, URL routing, Control API queries, committed settings mutations, and structured error states |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Operator console vertical slice |
| 2026-07-13 | working tree | `make test-e2e` | Chromium passed against the production Vite build | Login, operations, hostile-content escaping, committed settings mutation, and mobile navigation |
| 2026-07-13 | working tree | `make verify-fast` | 271 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Fastify production asset caching, SPA fallback isolation, structured API 404s, and restrictive response headers |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | One-port static hosting boundary |
| 2026-07-13 | working tree | `make verify-fast` | 279 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Production exports, runtime options, initialized startup/readiness, same-port ownership, and idempotent shutdown |
| 2026-07-13 | working tree | `make test-integration` | Emitted Node server passed real loopback health/readiness/UI/SIGTERM/SQLite stop checks | Normal Node production distribution |
| 2026-07-13 | working tree | `pnpm --filter @symphony/server --prod deploy --legacy /tmp/...` | Portable production layout contains the built server and compiled workspace dependencies | Container payload boundary |
| 2026-07-13 | working tree | `actionlint 1.7.12` | Both commit-pinned workflows passed | Workflow syntax and expression validation |
| 2026-07-13 | working tree | `zizmor 1.26.1 --persona pedantic --offline` | No findings | Workflow security audit |
| 2026-07-13 | working tree | `make verify-fast` | 281 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Container policy, deferred-dependency enforcement, and delivery configuration |
| 2026-07-13 | working tree | `make verify-fast` | 289 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Full-workflow bootstrap candidate, narrow pristine exemption, exact loopback API/UI, and durable authority identity |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | First-run bootstrap and operational runbook slice |
| 2026-07-13 | working tree | `make verify-fast` | 294 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Ordinary workflow startup, durable bootstrap operator override, restart-bound application, and secure persisted bind |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Ordinary startup configuration integration |
| 2026-07-13 | working tree | `make verify-fast` | 296 tests; lint, contract/OpenAPI/client drift, and typecheck passed | One-terminal dev supervision, signal forwarding, and sibling-failure teardown |
| 2026-07-13 | working tree | `bash -n scripts/verify-container.sh` | Container smoke script parsed successfully | Non-root read-only runtime, loopback bootstrap, health/readiness/UI, volume restart, and durable signal stop |
| 2026-07-13 | working tree | `actionlint 1.7.12` and `zizmor 1.26.1 --persona pedantic --offline` | Workflow syntax passed; no security findings | Image runtime smoke integration |
| 2026-07-13 | working tree | `node scripts/install-gitleaks.ts` and `scripts/verify-gitleaks.ts` | Checksum-pinned Gitleaks 8.30.1 installed; synthetic staged secret rejected with redacted output and clean staged content passed | Repository-owned pre-commit secret gate |
| 2026-07-13 | working tree | `make verify-fast` | 304 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Staged snapshot policy, Gitleaks installer mapping, Husky wiring, and commit-message policy |
| 2026-07-13 | working tree | `actionlint 1.7.12` and `zizmor 1.26.1 --persona pedantic --offline` | Publication and release workflows passed syntax; no unsuppressed security findings | Protected-main artifact publication and digest-only tag promotion |
| 2026-07-13 | working tree | `pnpm exec vitest run packages/adapters/src/linux-process-ownership.test.ts` (five consecutive runs) | All four process-ownership tests passed each run | `/proc` ENOENT/ESRCH process-exit race tolerance |
| 2026-07-13 | working tree | `make verify-fast` | 307 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Publication/release policy plus process-exit race regression |
| 2026-07-13 | working tree | `make verify-fast` | 311 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Operator-store corruption terminates owned processes, records observed receipts and durable failure, and exits fail closed |
| 2026-07-13 | working tree | `make verify-fast` | 320 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Supervised synthesis triggering, lesson-backed saturation and decay, and one-active-SystemJob durability |
| 2026-07-13 | working tree | `node scripts/conformance-report.ts /tmp/symphony-core-conformance.json` | Exited 1 after writing an exact-revision report with two completed and 33 missing Core IDs | Honest partial conformance reporting; Real Integration remains `not_run` |
| 2026-07-13 | working tree | `make verify-fast` | 324 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Conformance schema, ledger parsing, Make interface, and partial-result safeguards |
| 2026-07-13 | working tree | `make verify-fast` | 329 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Complete-snapshot validation and revision-pinned GitHub repository-hosting authority boundary |
| 2026-07-13 | working tree | `make verify-fast` | 332 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Production workflow file detection, immutable live snapshots, last-known-good rejection, durable reload events, and cleanup-safe shutdown |
| 2026-07-13 | working tree | `make verify-fast` | 336 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Required-skill root precedence, symlink containment, content hashing, and exact agent manifest preflight |
| 2026-07-13 | working tree | `make verify-fast` | 403 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Live Codex model-catalog pagination, manifest profile resolution, protocol-shape pinning, and fail-closed catalog validation |
| 2026-07-13 | working tree | `make verify-fast` | 408 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Exact initial issue dispatch composition, applying-intent persistence, revision-required tracker receipt, confirmed stage transition, and launch ordering |
| 2026-07-13 | working tree | `make verify-fast` | 410 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Immutable workspace checkout migration, claim-bound provenance, replay/conflict behavior, and provenance-gated startup ownership |
| 2026-07-13 | working tree | `make verify-fast` | 414 tests; lint, contract/OpenAPI/client drift, and typecheck passed | GitHub default-branch resolution, credential-scoped clone, credential-free local branch/revision verification, containment, cleanup, and real argv subprocess boundary |
| 2026-07-13 | working tree | `make verify-fast` | 416 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Checkout reuse, after-create crash boundary, claim-bound provenance commit, before-run hooks, and scrubbed worker environment composition |
| 2026-07-13 | working tree | `make verify-fast` | 421 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Session-start identity binding, persistence-failure cancellation, atomic absolute usage samples, non-negative derived deltas, and cost/token regression rejection |
| 2026-07-13 | working tree | `make verify-fast` | 425 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Durable agent stream ordering, terminal result requirement, priced cached-input cost, store-before-cancel hard caps, confirmed exit, and persistence safety cancellation |
| 2026-07-13 | working tree | `make verify-fast` | 434 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Strict workflow-prompt interpolation, complete documented roots, deterministic structured values, missing-value rejection, and prototype-path protection |
| 2026-07-13 | working tree | `make verify-fast` | 435 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Negotiated role-schema binding and fail-closed terminal-result validation before outcome routing |
| 2026-07-13 | working tree | `make verify-fast` | 444 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Configured role/class compute routes, ordered risk-floor normalization, deterministic predicate validation, and duplicate/malformed rule rejection |
| 2026-07-13 | working tree | `make verify-fast` | 447 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Restart-safe next-attempt numbering and bounded chronological same-role/profile usage-history reads for dispatch planning |
| 2026-07-13 | working tree | `make verify-fast` | 450 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Preflight-before-charge initial issue planning, configured risk routing, strict prompt construction, historical token/USD estimates, and fully pinned canonical dispatch records |
| 2026-07-13 | working tree | `make verify-fast` | 451 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Receipt-first initial issue execution through workspace hooks/provenance, scrubbed launch request, and atomic running LiveSession binding |
| 2026-07-13 | working tree | `make verify-fast` | 452 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Atomic pre-session launch-failure result, zero-usage budget settlement, Ready claim routing, and persistence safety escalation |
| 2026-07-13 | working tree | `make verify-fast` | 457 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Lossless normalized Plan events, negotiated Plan validation, sequential attempt/work-bound persistence, and mutable-revision supersession |
| 2026-07-13 | working tree | `make verify-fast` | 460 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Durable consumption-state loading, role-result/ExecutionFailure closure, actual all-ledger settlement, and Ready/AwaitingHuman claim routing |
| 2026-07-13 | working tree | `make verify-fast` | 461 tests; lint, contract/OpenAPI/client drift, and typecheck passed | One-call receipt-gated launch, normalized stream consumption, hard-cap enforcement, terminal closure, and durable budget settlement lifecycle |
| 2026-07-13 | working tree | `make verify-fast` | 462 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Production candidate eligibility, slot/claim gating, prompt/routing configuration, receipt-gated workspace/session launch, background consumption, closure, and settlement |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Production scheduler and workflow-prompt composition |
| 2026-07-13 | working tree | `make verify-fast` | 469 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Binding-gated in-session Plan decisions, coverage/path/estimate validation, replay-safe persistence, durable validation, and `PLAN.md` projection |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | In-session Plan gate and projection composition |
| 2026-07-13 | working tree | `make verify-fast` | 472 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Configured Plan path facts, provisional floors, first authoritative class, atomic Plan/Attempt classification, and high-risk stop instruction |
| 2026-07-13 | working tree | `make verify-fast` | 474 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Durable Plan-gate state reads, pre-Plan action cancellation, and enforced high-risk `plan_ready` terminal contract |
| 2026-07-13 | working tree | `make verify-fast` | 475 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Bound adapter-stream exception termination, confirmed exit, failure closure, Ready claim routing, and budget settlement |
| 2026-07-13 | working tree | `make verify-fast` | 477 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Reason-CAS Ready continuation dispatch with atomic Attempt, running lease, reservation, and ledger rollback |
| 2026-07-13 | working tree | `make verify-fast` | 478 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Validated Plan recovery and fresh-context economy Plan-review preflight, routing, history estimation, budget preparation, and continuation planning |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | High-risk Plan-review planning composition |
| 2026-07-13 | working tree | `make verify-fast` | 486 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Charged Plan-review workspace/session lifecycle, all atomic decisions, rejected-revision cap, durable question parking, semantic mismatch failure, and zero-use launch-failure settlement |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | High-risk Plan-review execution and outcome composition |
| 2026-07-13 | working tree | `make verify-fast` | 487 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Durable Plan-review Ready-claim pickup without tracker candidates, shared slot accounting, production lifecycle tracking, and approval closure |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Production Plan-review Ready dispatch composition |
| 2026-07-13 | working tree | `make verify-fast` | 489 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Approved high-risk Plan action/completion gate, unapproved `plan_ready` enforcement, and approval supersession on revised Plan submission |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Approved Plan implementation-gate composition |
| 2026-07-13 | working tree | `make verify-fast` | 491 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Deep approved-Plan and rejected-Plan implementation-continuation preflight, budgeting, factual handoff prompts, remaining-budget guidance, and revision instruction |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Implementation-continuation planning composition |
| 2026-07-13 | working tree | `make verify-fast` | 493 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Typed durable review/Plan handoff recovery, charged approved/revision implementation lifecycles, session-bound Plan callbacks, revision-before-action enforcement, and multi-tick production scheduling |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Post-review implementation-continuation execution composition |
| 2026-07-13 | working tree | `make verify-fast` | 497 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Passing agent-evidence enforcement, typed completed-target recovery, actual HEAD resolution, sandbox/none verification, atomic evidence plus review/rework routing, and multi-tick production execution |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Independent verification production composition |
| 2026-07-13 | working tree | `make verify-fast` | 503 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Passing-verification review-target recovery, deterministic immutable patch evidence, standard fresh-context reviewer budgeting/lifecycle, atomic Review Record persistence, partial-set routing, and wrong-SHA rejection |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Integrative review production composition |
| 2026-07-13 | working tree | `make verify-fast` | 504 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Durable complete reviewer-set recovery, partial-set rejection, no-voting aggregate decisions, atomic ordinary ReviewSet persistence/routing, and slot-independent standard coordinator pickup |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | Standard-class ReviewSet coordination composition |
| 2026-07-13 | working tree | `make verify-fast` | 507 tests; lint, contract/OpenAPI/client drift, and typecheck passed | Exact specialist configuration validation, deterministic trigger selection, durable Plan/risk/patch fact recovery, exact diff line counts, and ordered high-risk missing-specialist routing |
| 2026-07-13 | working tree | `make build` | All packages and production web bundle built | High-risk specialist selection and fan-out routing composition |
