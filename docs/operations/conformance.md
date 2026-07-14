# Conformance reports

Run the deterministic profile with:

```sh
make conformance
```

The command validates the reviewed normative registry, creates an invocation-trusted but completely
unmapped Core diagnostic envelope, then writes `artifacts/conformance/core.json`. It does not run Core
tests yet. Run `make verify` separately for the complete repository gate. The schema-version 2 report
records the exact clean Git revision when available, implementation and specification versions,
source and registry digests, adapter status and versions, enabled extensions, completed and missing
Core test IDs, implementation-defined choices, and the Real Integration result. A dirty or otherwise
invalid repository snapshot produces a null revision and a diagnostic instead of guessed provenance.

`normative_registry.status: validated_identity` proves only that the exact reviewed source documents
and 761-row inventory were present. It does not prove any requirement was implemented. Until every
row has direct machine evidence, `results.normative_coverage.status` remains `unproven` and Core
Conformance remains false. If registry validation fails, the command still publishes a useful report
with `normative_registry.status: unavailable` and exits nonzero.

Version 2 makes `normative_registry.documents` the canonical specification-identity block and retains
`specifications` as a derived compatibility projection. Consumers must branch on `schema_version`;
version 2 adds the registry block and source/registry digests to version 1. The current command has no
success path and intentionally always exits nonzero because per-row and Core validators are not yet
connected. The report remains available after that expected failure so it can identify the gaps. Do
not describe an incomplete report as Core Conformance.

Core Conformance and production readiness are separate results. Core requires every normative
service requirement and deterministic matrix proof. Production readiness also requires a redacted,
passing Real Integration report from the selected non-production tracker, repository host, agent,
authentication, UI, hooks, and delivery path. Until that profile exists, the generated report says
`production_ready: false` and `real_integration.status: not_run`.

The `artifacts/` directory is ignored because reports are generated evidence, not source. Only a
clean-snapshot report identifies an exact working revision. A dirty-snapshot report is diagnostic and
must not be published as exact-revision evidence. CI publication should retain a clean report with
the artifact for that same revision.
