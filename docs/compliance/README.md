# Symphony Encore normative traceability

This directory maps every normative requirement in the top-level specification documents to its
implementation and direct evidence.

The matrices are:

- `spec-traceability.md` for `SPEC.md`;
- `tech-stack-traceability.md` for `TECH_STACK.md`; and
- `cicd-traceability.md` for `CICD.md`.

## Interpretation

The source documents remain normative. These matrices do not replace them.

Each source-ordered, independently statusable requirement has:

- a stable traceability ID;
- its source section and line;
- RFC 2119 strength;
- a concise statement that preserves the source meaning;
- current status;
- implementation location;
- direct test or operational evidence;
- remaining work;
- dependencies; and
- an owning workstream.

Rows do not use a broad umbrella plus narrower child rows for the same obligation. When one source
sentence contains independent strengths or behaviors, it receives separate rows. A grouped row is
allowed only when its fields share one strength, implementation status, evidence set, remaining
work, dependencies, and owner without hiding a separately testable contract.

Requirements introduced by a normative lead such as “the API MUST provide” include the list items
that inherit that lead. The matrices also inventory unkeyworded schemas, enums, transitions,
configuration tables, selected technology/runtime choices, delivery contracts, required operations
and surfaces, normalized events/errors, and reference-algorithm invariants that the source documents
declare normative. RFC boilerplate, examples, rationale, and non-normative references are excluded.

## Status values

`implemented` means direct evidence currently proves the complete requirement.

`partial` means useful implementation or evidence exists, but at least one required behavior or
composition is missing.

`missing` means no conforming production behavior was found.

`external proof` means repository code exists, but the requirement depends on live platform,
provider, repository-setting, publication, release, or integration evidence that is not present.

An `implemented` row may regress to `partial` when later integration exposes a missing composition.
Rows are promoted only from passing exact-revision evidence, never from file existence or prose.

## Workstreams

| Code | Scope |
|---|---|
| W0 | Traceability, evidence registry, conformance, and clean delivery baseline |
| W1a | Runtime services, deterministic characterization, and narrow seams before safety hardening |
| W1b | Typed boundaries and layer-aligned extraction after the W2 safety kernel |
| W2 | Exclusive writer, startup recovery, persistence safety, and external mutations |
| W3 | Configuration manager and authenticated control-mutation kernel |
| W4 | Agent posture, approvals, sandbox, credentials, process, and workspace security |
| W5 | Canonical scheduler, Ready handlers, questions, approvals, and reconciliation |
| W6 | Results, classification, budgets, verification, review, publication, merge, and repair |
| W7 | Learning, notifications, durable logs, quality, retention, and tombstones |
| W8 | Complete Control API and read models |
| W9 | Complete accessible operator web UI |
| W10 | Canonical build, coverage, mutation, CI, container, release, and governance gates |
| W11 | Core Conformance, Real Integration, publication, promotion, and production evidence |

The dependency order and detailed file ownership are maintained in
`docs/superpowers/plans/2026-07-13-symphony-encore-completion-roadmap.md`.

## Audited baseline

The initial matrices describe revision `090cd6b818097e72524d462ab03208625a94155e`.

At that revision:

- `make verify-fast` passed 161 test files and 581 tests;
- `make build` passed;
- PR `#3` remained a draft;
- CodeQL passed;
- the main CI workflow failed on clean-runner package-manager setup, workflow lint, image smoke,
  and the aggregate required check;
- the legacy prose-driven ledger marked two of 35 Core IDs complete; the corrected ledger retains
  only `C-DUR-03` as directly proven;
- the Real Integration Profile had not run; and
- repository branch and merge settings did not satisfy `CICD.md`.

The architecture review later committed at `1302c0b` changes documentation only and does not alter
the audited runtime status.

The normalized baseline has 327 `SPEC.md` rows, 204 `TECH_STACK.md` rows, and 230 `CICD.md` rows.
Counts are descriptive only; differently sized requirements are not interchangeable progress units.
