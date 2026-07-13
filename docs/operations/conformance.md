# Conformance reports

Run the deterministic profile with:

```sh
make conformance
```

The command first runs `make verify-fast`, then writes
`artifacts/conformance/core.json`. The report records the exact Git revision, implementation and
specification versions, adapter status and versions, enabled extensions, completed and missing Core
test IDs, implementation-defined choices, and the Real Integration result.

The command exits with a nonzero status while any Section 1–18 requirement or Core matrix proof is
incomplete. The report remains available after that expected failure, so it can identify the gaps.
Do not describe an incomplete report as Core Conformance.

Core Conformance and production readiness are separate results. Core requires every normative
service requirement and deterministic matrix proof. Production readiness also requires a redacted,
passing Real Integration report from the selected non-production tracker, repository host, agent,
authentication, UI, hooks, and delivery path. Until that profile exists, the generated report says
`production_ready: false` and `real_integration.status: not_run`.

The `artifacts/` directory is ignored because reports identify one exact working revision and are
generated evidence, not source. CI publication should retain the report with the artifact for that
same revision.
