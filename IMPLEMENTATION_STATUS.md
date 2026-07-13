# Symphony Encore implementation status

Last updated: 2026-07-13

This ledger records current verified coverage. The normative sources remain `SPEC.md`,
`TECH_STACK.md`, and `CICD.md`; the exhaustive source-level assessment lives in
`docs/compliance/`. A checked Core item means its complete named behavior has direct evidence at the
stated revision. File existence, authored workflows, fake-adapter success, and historical test
counts are not completion evidence.

## Current state

- Branch: `feat/symphony-encore-core`.
- Audited runtime revision: `090cd6b818097e72524d462ab03208625a94155e`.
- Architecture decision first committed at `1302c0b5342d854ab2a62481786a60faa0733d5f`; the local feature
  branch is documentation-ahead of the pull-request head until the next intentional push.
- Pull request: draft PR `#3`, <https://github.com/jporcenaluk/wheelsparrow/pull/3>.
- Pull-request head: `090cd6b818097e72524d462ab03208625a94155e`.
- Local deterministic baseline at the audited runtime revision: `make verify-fast` passed 161 test
  files and 581 tests. The current working tree passes the repaired Corepack command graph with 163
  files and 617 tests, lint, Markdown, repository policy, strict TypeScript, generated contract,
  OpenAPI/client drift, and `make build`; exact-head remote proof remains pending.
- Remote state at that revision: CodeQL passed; the main CI workflow failed; the required aggregate
  check is not green.
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

The normalized baseline contains 761 independently statusable contracts:

- `SPEC.md`: 54 implemented, 242 partial, 28 missing, and 3 awaiting external proof out of 327;
- `TECH_STACK.md`: 66 implemented, 112 partial, 8 missing, and 18 awaiting external proof out of
  204; and
- `CICD.md`: 34 implemented, 137 partial, 39 missing, and 20 awaiting external proof out of 230.

These counts describe requirement disposition, not percentage completion: rows differ substantially
in size and risk, and no partial row counts as conformance.

| Document | Current assessment | Matrix |
|---|---|---|
| `SPEC.md` | Partial. Substantial domain, persistence, scheduler, review, merge, repair, and synthesis code exists, but sole-writer, normal-startup intent recovery, persistence gating, agent isolation, rolling budgets, complete ReviewSet guards, Control API/UI breadth, durable logs, retention, and Real Integration remain incomplete. | `docs/compliance/spec-traceability.md` |
| `TECH_STACK.md` | Partial. The pinned TypeScript workspace and most selected libraries/builds exist, but typed Kysely boundaries, coverage, real production browser testing, dispatch-capable distribution, macOS runtime containment, and current WSL/container evidence remain incomplete. | `docs/compliance/tech-stack-traceability.md` |
| `CICD.md` | Partial. Workflows and release machinery are authored, but clean-runner CI is failing, required repository settings are absent, and artifact publication, provenance, promotion, rollback, platform, and release evidence have not passed remotely. | `docs/compliance/cicd-traceability.md` |

## Core Conformance

The exact 35-ID registry is now a typed, SPEC-bound evidence contract in
`packages/contracts/src/conformance.ts`. Its tests bind the seven headings, bullet order, normalized
requirement hashes, required platforms, and the four selected Core adapter kinds. This is a trust
boundary for future evidence, not proof that the cases ran: the canonical producer and fail-closed
reporter remain pending. At present, only `C-DUR-03` has direct behavioral evidence strong enough to
retain a checked status.

- [x] `C-DUR-03` Process ownership verification, tree termination, and interrupted-attempt closure.
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
9. The current conformance reporter still derives status from ledger prose and produces an
   output-formatting regression after an incomplete run; the new typed evidence contract is not yet
   connected to canonical execution or reporting.
10. Clean-runner package-manager, workflow-shell, and image-smoke defects are repaired in the
    current working tree, but none has fresh exact-head remote proof yet.

## Current verification evidence

| Date | Revision | Command or system | Result | Scope |
|---|---|---|---|---|
| 2026-07-13 | `090cd6b` | `make verify-fast` | Passed: 161 files, 581 tests | Deterministic unit/contract, lint, Markdown, policy, drift, and typecheck gate |
| 2026-07-13 | `090cd6b` | `make build` | Passed | All package builds and production web bundle |
| 2026-07-13 | `090cd6b` | GitHub CodeQL | Passed | Remote CodeQL workflow at PR head |
| 2026-07-13 | `090cd6b` | GitHub CI | Failed | Corepack/pnpm runner recursion, actionlint/ShellCheck, image smoke, and aggregate required check |
| 2026-07-13 | `090cd6b` | `make conformance` | Correctly exited nonzero, but report trust/format defects remain | Incomplete Core report; not conformance evidence |

Not yet proven at one exact revision: full `make verify`, clean-checkout `make conformance`, current
production-server browser E2E, local or remote non-root read-only container execution, macOS and WSL
release smoke, mutation thresholds, Real Integration, successful Linux/macOS PR workflows, and
publication/promotion/rollback.

## External repository and release state

- The default branch is `main`.
- No branch protection or repository ruleset currently enforces the required checks or merge queue.
- Merge commits and rebases are enabled alongside squash merges; this does not satisfy `CICD.md`.
- Auto-merge and update-branch support are disabled.
- No exact-revision artifact, SBOM, provenance, promotion-without-rebuild, or rollback proof has
  completed remotely.
- PR `#3` remains draft and its current title is not Conventional Commit compliant.

## Completion rule

This ledger may move a requirement to complete only from direct, exact-revision evidence produced by
the canonical runner or a live external observation with repository/target identity and freshness.
Historical checkpoints remain in git history; they are not current conformance evidence.
