# Deployment security posture

## Network binding

The service binds to `127.0.0.1` by default. Keep that default for local development, macOS, and
WSL. Non-loopback binding is an explicit production exception and cannot be used for first-run
bootstrap.

After loopback bootstrap, a non-loopback deployment requires both acknowledgments:

```sh
export SYMPHONY_HOST=0.0.0.0
export SYMPHONY_ALLOW_NON_LOOPBACK=true
export SYMPHONY_SECURE_COOKIES=true
make start
```

Terminate TLS at an authenticated reverse proxy, restrict inbound networks, preserve the original
client address, and expose only the one Fastify port. Secure cookies require browser access through
HTTPS. Never use `0.0.0.0` as a localhost-forwarding workaround.

## Credentials

Provide bootstrap, tracker, and provider credentials through the host secret manager or process
environment. Never place literal credentials in `WORKFLOW.md`, an image layer, a command-line
argument, a browser bundle, or a checked-in `.env` file. Rotate the one-time bootstrap credential
out of the environment immediately after use.

The service hashes local passwords with scrypt and stores only hash material. Sessions use random
opaque tokens and persist only token hashes. Configuration snapshots retain secret references such
as `$GITHUB_TOKEN`, never resolved values.

## Agent and hook boundary

On Linux and WSL, verification and hook subprocesses run through Bubblewrap with a scrubbed
environment, an isolated home directory, a read-only host view, and write access only to the owned
workspace and temporary paths. Install `bubblewrap`, `git`, and `procps` on the host. macOS requires
an equivalent deployment control before enabling unattended execution; the current Linux
Bubblewrap runner does not establish a macOS sandbox.

`env.allowlist` grants a name to the isolated process; it does not make broad host credentials safe.
Use narrow tokens, keep tracker mutations in the trusted adapter, and never allowlist secret-manager
control credentials. The agent's approval policy and thread/turn sandbox values must match the
selected adapter and remain visible in `WORKFLOW.md` or an acknowledged operator override.

## Container posture

The image runs as UID/GID 10001 under Tini. After initializing the data volume through a trusted
loopback session, run it with a read-only root filesystem, a writable `/var/lib/symphony` volume,
and a bounded temporary filesystem. Inject secrets only when the container starts.

```sh
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --mount type=volume,src=symphony-data,dst=/var/lib/symphony \
  --mount type=bind,src="$PWD/WORKFLOW.md",dst=/opt/symphony/WORKFLOW.md,readonly \
  --publish 127.0.0.1:8080:8080 \
  --env SYMPHONY_HOST=0.0.0.0 \
  --env SYMPHONY_ALLOW_NON_LOOPBACK=true \
  --env SYMPHONY_SECURE_COOKIES=true \
  --user 10001:10001 symphony-encore:verified
```

First-run container bootstrap still requires a loopback-reachable operator channel. Use Linux host
networking for that controlled first start or prepare the persistent volume through an equivalent
loopback-only administrative session. Do not weaken the service to a public bootstrap bind.
