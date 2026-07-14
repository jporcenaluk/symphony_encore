# Symphony Encore implementation status

Last updated: 2026-07-14

This ledger records current verified coverage. The normative sources remain `SPEC.md`,
`TECH_STACK.md`, and `CICD.md`; the exhaustive source-level audit baseline lives in
`docs/compliance/`. This ledger records subsequent evidence while those matrices await a complete
status-and-evidence reconciliation. A checked Core item means its complete named behavior has direct
evidence at the stated revision. File existence, authored workflows, fake-adapter success, and
historical test counts are not completion evidence.

## Current state

- Branch: `feat/symphony-encore-core`.
- Traceability audit baseline: `090cd6b818097e72524d462ab03208625a94155e`.
- Architecture decision first committed at `1302c0b5342d854ab2a62481786a60faa0733d5f`.
- Pull request: draft PR `#3`, <https://github.com/jporcenaluk/wheelsparrow/pull/3>.
- Current working-tree deterministic baseline: `make verify-fast` passes 175 test files and 771
  tests, including the 761-row normative registry and its fail-closed CLI boundary.
- Most recent externally verified PR checkpoint preceding this ledger revision:
  `9f1983e634ca75c5f91df721129551fdae03ae8d`. Linux verification, mocked-API Playwright E2E, a
  separate production-server integration smoke, macOS verification, supply-chain checks, image
  build, non-root/read-only container verification, Trivy, CodeQL, and the aggregate required job
  passed.
- Core Conformance: not achieved.
- Real Integration Profile: not run.
- Production readiness: false.

## Architectural decision

The selected completion strategy is a targeted, layer-aligned refactor. Runtime characterization
seams come first, followed by a pre-database OS service lock, fencing, startup recovery, and a
fail-closed privileged-mutation kernel. Only then may scheduler, publication, and merge behavior move
from `apps/server` into `packages/orchestration`. The detailed decision and dependency order are:

- `docs/superpowers/specs/2026-07-13-symphony-encore-completion-design.md`;
- `docs/superpowers/plans/2026-07-13-symphony-encore-completion-roadmap.md`; and
- `docs/superpowers/plans/2026-07-13-evidence-and-ci-baseline.md`.

## Normative coverage

The matrices assign source-ordered identities to explicit and inherited RFC 2119 requirements and
to the schemas, enums, transitions, configuration tables, required surfaces, adapter operations,
event/error mappings, and algorithm invariants that the documents separately declare normative.
Each row records implementation, direct evidence, status, remaining work, dependency, and owner.

Reviewed machine registries now bind every row to the exact raw source-document digest, cited source
fragment, RFC strength, statement, semantic kind, applicability, and aggregate membership. The
canonical validator rejects semantic reassignment and reports 761 requirements. The schema-version 2
conformance report accepts this identity only from an invocation-authenticated, deeply frozen
summary; this does not change normative coverage from `unproven`.

The normalized baseline contains 761 source-ordered registry rows with explicit
aggregate/profile/reference relationships. The current human-authored matrices contain the
following mixed-revision editorial dispositions, which still require complete evidence
reconciliation:

- `SPEC.md`: 54 implemented, 242 partial, 28 missing, and 3 awaiting external proof out of 327;
- `TECH_STACK.md`: 66 implemented, 112 partial, 8 missing, and 18 awaiting external proof out of
  204; and
- `CICD.md`: 34 implemented, 137 partial, 39 missing, and 20 awaiting external proof out of 230.

These counts describe requirement disposition, not percentage completion: rows differ substantially
in size and risk, and no partial row counts as conformance.

| Document | Current assessment | Audit-baseline matrix |
|---|---|---|
| `SPEC.md` | Partial. Substantial domain, persistence, scheduler, review, merge, repair, and synthesis code exists, but sole-writer, normal-startup intent recovery, persistence gating, agent isolation, rolling budgets, complete ReviewSet guards, Control API/UI breadth, durable logs, retention, and Real Integration remain incomplete. | `docs/compliance/spec-traceability.md` |
| `TECH_STACK.md` | Partial. The pinned TypeScript workspace and most selected libraries/builds exist, but typed Kysely boundaries, coverage, real production browser testing, dispatch-capable distribution, macOS runtime containment, and current WSL/container evidence remain incomplete. | `docs/compliance/tech-stack-traceability.md` |
| `CICD.md` | Partial. Linux, macOS, supply-chain, CodeQL, image, container, Trivy, and aggregate PR checks pass at `810dd02`, but required repository settings are absent and artifact publication, provenance, promotion, rollback, WSL, and release evidence remain incomplete. | `docs/compliance/cicd-traceability.md` |

## Core Conformance

The exact 35-ID registry is now a typed, SPEC-bound evidence contract in
`packages/contracts/src/conformance.ts`. Its tests bind the seven headings, bullet order, normalized
requirement hashes, required platforms, and the four selected Core adapter kinds. The canonical
producer now creates same-invocation, exact-repository evidence, and the reporter rejects prose,
forged objects, stale provenance, and caller-selected output paths. This is still an intentionally
incomplete foundation: all 35 cases remain missing and unmapped, and both completion booleans remain
false.

- [ ] `C-DUR-03` — focused process-ownership behavior exists, but the canonical producer does not yet
  map and execute the complete case as immutable Core evidence.
- [ ] `C-WF-01` through `C-WF-07` — workflow/configuration compositions remain incomplete.
- [ ] `C-DUR-01`, `C-DUR-02`, `C-DUR-04`, and `C-DUR-05` — sole writer, complete restart,
  normal-startup intent recovery, and mutation shutdown remain incomplete.
- [ ] `C-PLAN-01` through `C-PLAN-04` — duplicate results, final-diff reclassification, complete
  routing/recovery, and salvage evidence remain incomplete.
- [ ] `C-BUD-01` through `C-BUD-04` — aggregate queries, rolling windows, top-ups, fan-out,
  overrun/reset/resume controls, and complete reconstruction evidence remain incomplete.
- [ ] `C-REV-01` through `C-REV-05` — durable Guard Decisions, carry-forward, escaped-defect
  feedback, notifications, and sampled audits remain incomplete.
- [ ] `C-UI-01` through `C-UI-07` — complete API/UI resources, restart history, durable scrubbed
  logs, full mutation audit, and retention/tombstones remain incomplete.
- [ ] `C-SEC-01` through `C-SEC-03` — real agent isolation, credential-inaccessibility, macOS, and
  universal privileged-mutation mediation remain incomplete.

`C-UI-04` is intentionally unchecked: the current settings vertical slice preserves selected
failed input, but it does not prove the required mutation breadth, committed-state readback, and all
failure classes.

## Highest-risk open defects

1. No pre-database, lifetime-exclusive service writer lock or durable fencing epoch exists.
2. Ordinary startup does not reconcile every applied-but-unreceipted provider intent before
   dispatch and mutation become available.
3. Persistence health is not rechecked immediately before every privileged provider call.
4. Production scheduling diverges from the normative poll order and omits complete AwaitingHuman
   reconciliation; some Ready reasons can be stranded.
5. The Codex process ignores configured approval/sandbox posture and is not proven inside the
   required OS/credential boundary.
6. Runtime configuration overrides are shallowly validated and accepted hot/attempt changes do not
   update the running scheduler.
7. Duplicate terminal results, final-diff upward reclassification, rolling budgets, and complete
   Guard Decision/ReviewSet behavior are not implemented.
8. The Control API, accessible operator UI, durable LogRecord history, notifications, quality
   metrics, retention, and tombstones are incomplete.
9. The conformance producer has no immutable selector execution or hosted attestation path yet; all
   35 Core cases therefore remain explicitly unmapped.
10. Normative rows have reviewed machine identities but no exhaustive per-row machine-evidence
    mapping, so normative coverage remains unproven.

## Current verification evidence

| Date | Revision | Command or system | Result | Scope |
|---|---|---|---|---|
| 2026-07-13 | `090cd6b` | `make verify-fast` | Passed: 161 files, 581 tests | Deterministic unit/contract, lint, Markdown, policy, drift, and typecheck gate |
| 2026-07-13 | `090cd6b` | `make build` | Passed | All package builds and production web bundle |
| 2026-07-13 | `090cd6b` | GitHub CodeQL | Passed | Remote CodeQL workflow at PR head |
| 2026-07-13 | `090cd6b` | GitHub CI | Failed | Corepack/pnpm runner recursion, actionlint/ShellCheck, image smoke, and aggregate required check |
| 2026-07-13 | `090cd6b` | `make conformance` | Correctly exited nonzero, but report trust/format defects remain | Incomplete Core report; not conformance evidence |
| 2026-07-14 | `a37874f` | GitHub PR checks | Applicable PR gates passed; main-only publication skipped by design | Linux verification, mocked-API Playwright E2E, production-server integration smoke, macOS verification, supply chain, image/container/Trivy, CodeQL, and aggregate required |
| 2026-07-14 | `810dd02` | `make verify-fast` | Passed: 175 files, 767 tests | Includes exact 761-row normative validation and CLI failure-path verification |
| 2026-07-14 | `810dd02` | `make conformance` | Correctly exits nonzero and publishes a deterministic private report | Trusted incomplete evidence; 35 missing and 35 unmapped; both completion booleans false |
| 2026-07-14 | `810dd02` | GitHub PR checks | Applicable PR gates passed; main-only publication skipped by design | Linux verification, mocked-API Playwright E2E, production-server integration smoke, macOS verification, supply chain, image/container/Trivy, CodeQL, and aggregate required |
| 2026-07-14 | `9f1983e` | GitHub PR checks | Applicable PR gates passed; main-only publication skipped by design | Documentation-only status reconciliation; Linux, macOS, supply chain, image/container, required aggregate, and CodeQL passed |

Not yet proven at one exact revision: full local `make verify`, a successful `make conformance` with
mapped evidence, WSL release smoke, mutation thresholds, Real Integration, and
publication/promotion/rollback.

## External repository and release state

- The default branch is `main`.
- No branch protection or repository ruleset currently enforces the required checks or merge queue.
- Merge commits and rebases are enabled alongside squash merges; this does not satisfy `CICD.md`.
- Auto-merge and update-branch support are disabled.
- Only diagnostic workflow artifacts have been emitted. No deployable product artifact, SBOM,
  provenance, promotion-without-rebuild, or rollback proof has completed remotely.
- PR `#3` remains draft; its title, `feat: implement Symphony Encore control plane`, follows the
  repository's Conventional Commit pattern.

## Completion rule

This ledger may move a requirement to complete only from direct, exact-revision evidence produced by
the canonical runner or a live external observation with repository/target identity and freshness.
Historical checkpoints remain in git history; they are not current conformance evidence.
