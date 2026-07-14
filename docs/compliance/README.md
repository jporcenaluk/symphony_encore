# Symphony Encore normative traceability

This directory maps every normative requirement in the top-level specification documents to its
implementation and direct evidence.

The matrices are:

- `spec-traceability.md` for `SPEC.md`;
- `tech-stack-traceability.md` for `TECH_STACK.md`; and
- `cicd-traceability.md` for `CICD.md`.

The reviewed machine registries are:

- `registry/spec.requirements.json` for all 327 `SPEC.md` rows;
- `registry/tech-stack.requirements.json` for all 204 `TECH_STACK.md` rows; and
- `registry/cicd.requirements.json` for all 230 `CICD.md` rows.

Run `corepack pnpm normative:check` to verify the exact raw source-document digests, reviewed
whole-registry digests, contiguous IDs, RFC 2119 strengths, source-fragment digests, applicability,
semantic aggregate membership, and the complete 761-row inventory. Each fragment digest covers the
exact cited line ranges in textual order after CRLF-to-LF normalization, retains their normalized
line terminators, and adds no separator between disjoint ranges.

Run `corepack pnpm traceability:check` to verify the Markdown matrices against that catalog and to
check their assessment metadata, editorial status counts, semantic matrix digests, and generated
summary in `IMPLEMENTATION_STATUS.md`. Use `corepack pnpm traceability:generate` only to refresh the
generated summary after an intentional reviewed matrix edit. The generator uses crash-atomic
replacement and rejects input or status edits it observes before replacement, but POSIX files do
not provide content compare-and-swap. Serialize this maintenance command with other editors, review
its diff, and run the non-mutating `traceability:check`; CI relies only on the check operation.

## Interpretation

The source documents remain normative. These matrices do not replace them.

Each source-ordered requirement has:

- a stable traceability ID;
- its source section and line;
- RFC 2119 strength;
- a concise statement that preserves the source meaning;
- an editorial status for the matrix's declared assessment basis;
- implementation location;
- direct test or operational evidence;
- remaining work;
- dependencies; and
- an owning workstream.

Rows do not use a broad umbrella plus narrower child rows for the same obligation. When one source
sentence contains independent strengths or behaviors, it receives separate rows. A grouped row is
allowed only when its fields share one strength, implementation status, evidence set, remaining
work, dependencies, and owner without hiding a separately testable contract.

The machine registries retain semantic umbrella rows instead of treating them as independent proof
slots. `aggregate` entries name their direct member rows, `profile` entries identify executable
conformance profiles, and `reference` entries preserve normative reference contracts. Membership
never implies that the umbrella has passed: every retained row still requires its own applicable
direct evidence or explicit `SHOULD` justification.

Requirements introduced by a normative lead such as “the API MUST provide” include the list items
that inherit that lead. The matrices also inventory unkeyworded schemas, enums, transitions,
configuration tables, selected technology/runtime choices, delivery contracts, required operations
and surfaces, normalized events/errors, and reference-algorithm invariants that the source documents
declare normative. RFC boilerplate, examples, rationale, and non-normative references are excluded.

## Status values

In an `exact_revision` assessment, `implemented` means direct evidence at the declared revision
proves the complete requirement.

`partial` means useful implementation or evidence exists, but at least one required behavior or
composition is missing.

`missing` means no conforming production behavior was found.

`external proof` means repository code exists, but the requirement depends on live platform,
provider, repository-setting, publication, release, or integration evidence that is not present.

An `implemented` row may regress to `partial` when later integration exposes a missing composition.
Rows are promoted only from passing exact-revision evidence, never from file existence or prose.

Each matrix declares one strict metadata record immediately after its heading. `legacy_mixed` means
the rows span multiple implementation revisions and are planning evidence only; its revision is
always null. `exact_revision` means every row received a complete editorial audit against the named
40-character Git revision. It still does not turn an editorial status into executable conformance
evidence.

The traceability checker computes a semantic SHA-256 digest over the assessment metadata and all ten
cells of every source-ordered row. It understands pipes inside Markdown code spans and escaped pipes.
The generated status block records those digests and derives counts directly from the matrices.
Neither the checker nor its generated summary may be imported by the conformance reporter or evidence
producer.

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

## Audit history

The initial audit began at revision `090cd6b818097e72524d462ab03208625a94155e`, but selected rows
were edited after that checkpoint as early fixes landed. The current matrices therefore declare
`legacy_mixed`; they are neither a frozen `090cd6b` snapshot nor current exact-revision evidence.

At that revision:

- `make verify-fast` passed 161 test files and 581 tests;
- `make build` passed;
- PR `#3` remained a draft;
- CodeQL passed;
- the main CI workflow failed on clean-runner package-manager setup, workflow lint, image smoke,
  and the aggregate required check;
- historical prose-driven ledgers marked Core IDs complete without canonical evidence; the current
  producer maps none of the 35 cases;
- the Real Integration Profile had not run; and
- repository branch and merge settings did not satisfy `CICD.md`.

The architecture review later committed at `1302c0b` changes documentation only and does not alter
the historical runtime facts above.

The normalized baseline has 327 `SPEC.md` rows, 204 `TECH_STACK.md` rows, and 230 `CICD.md` rows.
Counts are descriptive only; differently sized requirements are not interchangeable progress units.
