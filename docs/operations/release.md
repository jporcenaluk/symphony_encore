# Release, WSL, and rollback runbook

## Release gate

Run the pinned repository gate from a clean checkout:

```sh
make verify
```

The gate checks formatting and generated artifacts, typechecks, runs unit and integration tests,
builds the production server and UI, exercises the built browser application, and builds the image.
Record the commit, lockfile hash, workflow run, and immutable image digest. A green Linux job does
not prove Windows-host-to-WSL networking.

## WSL release smoke

Run this check on a supported WSL 2 distribution for every release until a trustworthy hosted WSL
runner exists.

1. In WSL, run `make setup`, `make build`, and the loopback bootstrap from the operator runbook.
2. Confirm the WSL console prints `http://127.0.0.1:8080` and the full candidate hash.
3. In Windows PowerShell, run `curl.exe http://localhost:8080/health` and
   `curl.exe -I http://localhost:8080/operations`.
4. Open `http://localhost:8080/operations` in a Windows browser and log in.
5. Confirm `/ready` returns 200, the operations view loads, and hostile synthetic issue text renders
   as text rather than markup.
6. Stop the service with Ctrl+C in WSL. Confirm the process exits, no child process remains, and the
   latest `service_runs` row is `stopped` with reason `signal`.
7. Restart without bootstrap variables and repeat the Windows health, ready, UI, and login checks.

Record the Windows version, `wsl --version`, distribution, kernel, browser, commit, and redacted
results. Treat any localhost-forwarding failure as a release failure; do not switch the service to
`0.0.0.0` to make the check pass.

## Artifact rollback

Automatic deployment stays disabled until each target environment names its artifact registry,
database backup mechanism, owner, and health check. Rollback selects a previously verified artifact
digest. Never rebuild an old commit against a newer lockfile or base image.

Before deployment:

1. Stop mutations and wait for active attempts to reach a durable boundary.
2. Record the current application and image digests.
3. Take and verify an SQLite backup while the service is stopped or through the SQLite backup API.
4. Confirm the new migration has either backward-compatible readers or a tested forward-repair plan.
5. Retain the previous verified artifact and its matching configuration.

To roll back application code, stop the service, select the recorded prior digest, preserve the
database volume, start the prior artifact, and verify `/health`, `/ready`, login, history, and a
read-only reconciliation cycle. If the prior binary cannot read the migrated schema, stop. Restore
the verified pre-deploy database backup only after accounting for post-deploy writes, or deploy the
tested forward repair. Never run an ad hoc down-migration against the only database copy.

Record the decision, artifact digest, database backup identity, timestamps, operator, and smoke-test
evidence in the deployment log.
