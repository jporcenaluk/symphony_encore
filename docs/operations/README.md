# Operator runbook

## Install and build

Symphony Encore supports Node.js 24 on Linux, macOS, and Linux under WSL. Native Windows is not a
supported service host.

```sh
make setup
make build
```

Create a `WORKFLOW.md` before the first start. At minimum, its YAML front matter must configure the
tracker, workspace verification, local authentication, and the agent approval and sandbox posture.
The Markdown body is the agent prompt.

```yaml
---
agent:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
server:
  auth_kind: local
tracker:
  kind: github
  owner: example
  project_number: 1
  repo_owner: example
  repo_name: example
workspace:
  verify_command: make verify
---
Complete {{ issue.title }} and satisfy its acceptance criteria.
```

For source development, run both required processes under the repository supervisor:

```sh
make dev
```

Vite prints its loopback browser URL and proxies Control API calls to the source server on port
8080. Ctrl+C stops both process groups. If either process exits unexpectedly, the supervisor stops
its sibling and returns a failing status.

Replace every example tracker value. Keep credentials out of `WORKFLOW.md`; secret-valued config
uses a `$VARIABLE` reference.

## First start

Bootstrap works only with a pristine database and only over loopback. Generate a one-time value in
the same terminal that starts the service:

```sh
export SYMPHONY_BOOTSTRAP_AUTH_SUBJECT=local:admin
export SYMPHONY_BOOTSTRAP_CREDENTIAL="$(openssl rand -base64 32)"
make start
```

The process prints the UI URL and the complete `sha256:` candidate hash. Open the printed URL
yourself; Symphony never launches a browser. The setup form requires the auth subject, one-time
credential, a new local password, and an independently typed copy of the complete hash. Successful
bootstrap commits the administrator, auth mapping, acknowledged configuration snapshot, and audit
action in one SQLite transaction.

Stop the service, unset both bootstrap variables, and start it again:

```sh
unset SYMPHONY_BOOTSTRAP_AUTH_SUBJECT SYMPHONY_BOOTSTRAP_CREDENTIAL
make start
```

If an operator-empty database contains any other durable record, the service treats it as corrupt
recovery state and refuses bootstrap. Restore a known-good database; never delete selected rows to
force setup.

## Paths and mounts

The default database is `.symphony/symphony.sqlite3`; the default service workspace is
`.symphony/workspaces`. Set trusted startup paths before first start when a deployment needs stable
external storage:

```sh
export SYMPHONY_DATABASE_PATH=/var/lib/symphony/symphony.sqlite3
export SYMPHONY_WORKSPACE_ROOT=/var/lib/symphony/workspaces
export SYMPHONY_WORKFLOW_PATH=/etc/symphony/WORKFLOW.md
```

Give the service account read-write access only to the database directory, workspace root, and its
temporary directory. Mount `WORKFLOW.md` read-only in containers. Do not mount SSH agents, cloud
credential directories, Docker sockets, or a developer home directory into an agent workspace.

## Health and shutdown

`GET /health` proves process liveness and reports `starting`, `recovering`, `ready`, or `failed`.
`GET /ready` returns 200 only after recovery and bootstrap complete. SIGINT and SIGTERM stop the
active service run durably before the process exits.

Use the companion runbooks for the
[security posture](security.md) and [release, WSL, and rollback checks](release.md).
