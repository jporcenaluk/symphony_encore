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
| S03 | Complete durable domain model | In progress | Strict schemas and ten checksummed SQLite migrations cover every Section 3 record plus durable startup failures and the active-synthesis invariant; repository mappers beyond normalized issues remain pending |
| S04 | Change classification and proportional process | In progress | Pure staged/upward policy passes; orchestration gates pending |
| S05 | Issue and SystemJob lifecycle | In progress | Lane policy, deterministic eligibility/candidate ordering, a serialized/coalesced periodic/immediate scheduler with production start/stop lifecycle, exact reconciliation-first poll ordering, complete paginated candidate/revision ingestion with atomic first-observation/external-lane history, receipt-gated issue launch with synchronized durable issue state, atomic live-session/process binding, terminal claim release, fail-closed running identity/slot/claim reads, complete paginated tracker refresh plus default main reconciliation assembly, atomic issue and tracker-free SystemJob dispatch/closure, bounded issue/repair outcome routing, and running-attempt reconciliation ordering pass; default candidate dispatch and plan/review routes remain pending |
| S06 | Workspace isolation, hooks, and independent verification | In progress | Linux/WSL containment, full process-group termination, non-login hooks, durable verification, stable ownership, startup quarantine, and containment-checked post-commit terminal cleanup with best-effort `before_remove` pass; macOS and repository population pending |
| S07 | Token and USD budget enforcement | In progress | Replay, estimate, reservation, settlement, and monotonic absolute live-session accounting foundations pass |
| S08 | Compute routing | In progress | Deterministic role/class defaults, ordered risk floors, upward-only heuristics, and escalation caps pass; attempt pinning pending |
| S09 | Review coordination and immutable ReviewSets | In progress | Role contracts and ordinary ReviewSet policy pass |
| S10 | Git, pull requests, and serialized merge queues | In progress | Authorized intent/receipt durability and revision-pinned GitHub repository-hosting operation boundary pass; concrete Git transport and merge queues remain pending |
| S11 | Human questions, approvals, notifications, and controls | In progress | Authenticated reads plus a recovery-gated, CSRF-bound, capability/version/idempotency/audit protected configuration mutation pass; remaining mutation resources pending |
| S12 | Lessons, synthesis, and saturation | In progress | Deterministic interval/operator triggering, supervised deep routing, one-active-job SQLite enforcement, lesson citation, rule/prompt saturation, and completed-issue decay policies pass; lesson capture, attempt dispatch, review, and merge integration remain pending |
| S13 | Failure classification, retry, and restart recovery | In progress | Failure routing, intent reconstruction, interrupted closure with latest durable or factual first-attempt handoff, atomic post-shutdown reconciliation closure/settlement/claim routing, verified Linux tree termination, workspace recovery, production recovering-to-ready startup, operator-store corruption shutdown, orderly durable stop, a first-failure persistence safety latch that distinguishes provider refresh from observation-write failure, typed claim reconstruction, CAS lease renewal, retry-delay rebuilding, parked cursor/predicate rehydration, and terminal/lane/eligibility/stall reconciliation in the default process pass; dispatch and parked-work integration remain pending |
| S14 | Durable logs, events, quality metrics, and retention | In progress | Append-only Event Records, restart replay, authenticated paging, and abortable cursor-based SSE pass; logs, quality, retention, and tombstones pending |
| S15 | Security, authentication, bootstrap, and sandboxing | In progress | Loopback-only exact-hash bootstrap validates and snapshots the full workflow candidate, atomically creates matching local authority, and disables dispatch and mutations until completion; operator-empty non-pristine stores now terminate recorded processes, accept only provider-observed receipts, record a durable startup failure, and exit without replacing authority; concrete provider reconciliation wiring and macOS posture remain pending |
| S16 | GitHub tracker and repository-hosting adapters | In progress | Authenticated bounded `gh api` GraphQL transport, concrete Projects v2 candidate/state/comment/lane operations, native-terminal and priority normalization, fail-closed nested pagination, viewer-owned comment upserts, normalized complete PR snapshots, and revision-pinned operation authority pass; concrete Git mutation transport and project-schema repair remain pending |
| S17 | Codex app-server adapter | In progress | Installed Codex-generated bindings now anchor a bounded stdio client with initialize/thread/turn sequencing, pinned profiles, skills, typed `report_result`/`submit_plan`, normalized session/action/usage/terminal/turn events, schema rejection, unsupported-tool replies, request/read/turn/stall limits, and process-group shutdown; generated-schema manifest discovery, complete approval/error mapping, token/USD termination, salvage, and real subprocess proof remain pending |
| S18 | `WORKFLOW.md`, validation, reload, and overrides | In progress | Complete key catalog, precedence/provenance, semantic validation, serialized hash-based file detection, last-known-good rejection, durable accepted/rejected reload events, restart-bound pending state, durable overrides, exact-candidate acknowledgment, immutable snapshots, trusted path loading, and startup integration pass; full API/UI candidate and acknowledgment integration remains pending |
| S19 | Core and real-integration conformance reports | In progress | `make conformance` runs the fast deterministic gate, emits an exact-revision machine-readable partial report, and fails rather than claiming incomplete Core coverage; complete matrix and redacted real profile remain pending |

## Technology-stack coverage

| ID | Requirement area | Status | Required proof |
|---|---|---|---|
| T01 | Node 24 Active LTS, pnpm workspace, strict TypeScript, one lockfile | Implemented | Pinned files, frozen install, typecheck, and production workspace imports resolve to emitted JavaScript |
| T02 | Inward, acyclic package graph | Implemented | Repository policy tests and lint gate |
| T03 | React/Vite/TanStack/shadcn/Tailwind operator UI | In progress | Authenticated responsive React/Vite console, exact-hash first-run view, TanStack Router/Query/Table operations and settings slice, production build, Chromium flow, and Fastify static delivery pass; current bootstrap browser run, durable history/live-log/API breadth, and component-system completion pending |
| T04 | Fastify, TypeBox, OpenAPI, generated client, and SSE cursors | In progress | Typed loopback bootstrap, login, read, and configuration-mutation routes, structured errors, OpenAPI/client drift gates, durable SSE IDs, replay, EventSource requests, SPA fallback isolation, and restrictive response headers pass; remaining API resources pending |
| T05 | Pure domain transitions and transactional orchestration | In progress | Pure policies plus atomic dispatch, closure, authorized intent/receipt, and receipt-confirmed stage transitions pass |
| T06 | SQLite WAL, better-sqlite3, Kysely, immutable migrations | In progress | Eight checksummed migrations cover durable entities, evidence, append-only events, operators, and sessions; WAL, atomic transactions, configuration history, and restart round-trips pass |
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
