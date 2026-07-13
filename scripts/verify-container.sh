#!/usr/bin/env bash
set -euo pipefail

image="${1:-symphony-encore:verify}"
suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
container="symphony-verify-${suffix}"
volume="symphony-verify-${suffix}"
workflow="$(pwd)/tests/integration/container/WORKFLOW.md"
bootstrap_credential="$(openssl rand -hex 32)"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm --force "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null

run_container() {
  local bootstrap="${1:-false}"
  local -a environment=()
  if [[ "$bootstrap" == "true" ]]; then
    environment+=(
      --env SYMPHONY_BOOTSTRAP_AUTH_SUBJECT=local:container-smoke
      --env "SYMPHONY_BOOTSTRAP_CREDENTIAL=${bootstrap_credential}"
    )
  fi
  docker run --detach --name "$container" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --mount "type=volume,src=${volume},dst=/var/lib/symphony" \
    --mount "type=bind,src=${workflow},dst=/opt/symphony/WORKFLOW.md,readonly" \
    --health-interval 1s --health-start-period 1s --health-retries 15 --health-timeout 2s \
    "${environment[@]}" \
    "$image" >/dev/null
}

wait_for_start() {
  local attempt
  for attempt in $(seq 1 30); do
    if docker logs "$container" 2>&1 | grep --quiet 'Symphony Encore UI:'; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]]; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

run_container true
wait_for_start

test "$(docker inspect --format '{{.Config.User}}' "$container")" = "10001"
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" = '["tini","--"]'

docker exec --env "VERIFY_BOOTSTRAP_CREDENTIAL=${bootstrap_credential}" "$container" node -e '
  (async () => {
    const status = await fetch("http://127.0.0.1:8080/api/v1/bootstrap");
    if (!status.ok) throw new Error(`bootstrap status ${status.status}`);
    const candidate = await status.json();
    const completed = await fetch("http://127.0.0.1:8080/api/v1/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auth_subject: "local:container-smoke",
        bootstrap_credential: process.env.VERIFY_BOOTSTRAP_CREDENTIAL,
        confirmed_candidate_hash: candidate.candidate_hash,
        password: "synthetic container password",
        tracker_login: null,
      }),
    });
    if (!completed.ok) throw new Error(`bootstrap completion ${completed.status}`);
  })().catch((error) => { console.error(error); process.exit(1); });
'

docker exec "$container" node -e '
  (async () => {
    const health = await fetch("http://127.0.0.1:8080/health");
    const ready = await fetch("http://127.0.0.1:8080/ready");
    const ui = await fetch("http://127.0.0.1:8080/operations", {
      headers: { accept: "text/html" },
    });
    const bootstrap = await fetch("http://127.0.0.1:8080/api/v1/bootstrap");
    if (!health.ok || (await health.json()).service_state !== "ready") throw new Error("health");
    if (!ready.ok) throw new Error("ready");
    if (!ui.ok || !(await ui.text()).includes("<div id=\"root\"></div>")) throw new Error("ui");
    if (bootstrap.status !== 404) throw new Error("bootstrap remained enabled");
  })().catch((error) => { console.error(error); process.exit(1); });
'

docker exec "$container" test -w /var/lib/symphony/symphony.sqlite3
docker exec "$container" test -d /var/lib/symphony/workspaces
docker stop --time 15 "$container" >/dev/null
docker rm "$container" >/dev/null

run_container false
wait_for_start
docker exec "$container" node -e '
  fetch("http://127.0.0.1:8080/ready")
    .then((response) => { if (!response.ok) throw new Error(`ready ${response.status}`); })
    .catch((error) => { console.error(error); process.exit(1); });
'
docker stop --time 15 "$container" >/dev/null
docker rm "$container" >/dev/null

docker run --rm --read-only \
  --mount "type=volume,src=${volume},dst=/var/lib/symphony" \
  --entrypoint node "$image" -e '
    const Database = require("better-sqlite3");
    const database = new Database("/var/lib/symphony/symphony.sqlite3", { readonly: true });
    const rows = database.prepare("select status, end_reason from service_runs").all();
    if (rows.length !== 2 || rows.some((row) => row.status !== "stopped" || row.end_reason !== "signal")) {
      console.error(rows);
      process.exit(1);
    }
  '

printf 'Container runtime smoke passed\n'
