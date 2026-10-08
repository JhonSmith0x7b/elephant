#!/usr/bin/env bash
# Install as a root-owned, fixed SSH command. It only deploys the current main SHA.
set -Eeuo pipefail
umask 077

readonly root=/opt/elephant
readonly request=${1:-}
if [[ ! "$request" =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
  printf 'Only deploy <40-character commit SHA> is accepted.\n' >&2
  exit 2
fi
readonly revision=${BASH_REMATCH[1]}
exec 9>"$root/deploy.lock"
flock -w 1800 9

cd "$root/repository"
git fetch --quiet origin main
if [[ "$(git rev-parse origin/main)" != "$revision" ]]; then
  printf 'Commit is no longer the head of main; skipping superseded deployment.\n'
  exit 0
fi
git checkout --quiet --detach --force "$revision"

readonly release="$root/releases/$revision"
mkdir -p "$release" "$root/backups"
cp deploy/compose.production.yaml "$release/compose.yaml"
export ELEPHANT_IMAGE="elephant:$revision"
docker build --pull --tag "$ELEPHANT_IMAGE" .

compose() {
  docker compose --project-name elephant --env-file "$root/runtime.env" -f "$release/compose.yaml" "$@"
}

previous=""
[[ ! -f "$root/current-revision" ]] || previous=$(cat "$root/current-revision")
changed=0
rollback() {
  local code=$?
  trap - ERR
  if [[ "$changed" == 1 && -n "$previous" && -f "$root/releases/$previous/compose.yaml" ]]; then
    printf 'Deployment failed; restoring previous application containers.\n' >&2
    ELEPHANT_IMAGE="elephant:$previous" docker compose --project-name elephant \
      --env-file "$root/runtime.env" -f "$root/releases/$previous/compose.yaml" \
      up -d --no-build --wait --wait-timeout 120 web worker || true
  elif [[ "$changed" == 1 ]]; then
    compose stop web worker || true
  fi
  printf 'Deployment failed. Database backup retained; database is never automatically overwritten.\n' >&2
  exit "$code"
}
trap rollback ERR

compose up -d --wait --wait-timeout 120 postgres
# Both the scheduler and authenticated page actions can write to the database.
changed=1
compose stop web worker
compose exec -T postgres pg_dump -U reader -d reader --format=custom \
  > "$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$revision.dump"
compose run --rm --no-deps web node --import tsx scripts/migrate.ts
compose run --rm --no-deps web node --import tsx scripts/migrate-auth.ts
if [[ -f "$root/bootstrap.env" ]]; then
  # This password exists only for one-time initialization, never in web/worker env.
  set -a
  source "$root/bootstrap.env"
  set +a
  compose run --rm --no-deps -e ADMIN_PASSWORD web node --import tsx scripts/setup-auth.ts
  unset ADMIN_PASSWORD
  rm "$root/bootstrap.env"
fi
compose up -d --no-build --wait --wait-timeout 150 web worker
# An old heartbeat must not make a newly broken worker look healthy.
worker_started=$(docker inspect --format '{{.State.StartedAt}}' "$(compose ps -q worker)")
[[ "$worker_started" =~ ^[0-9TZ:.-]+$ ]]
heartbeat_ready=0
for attempt in {1..15}; do
  fresh=$(compose exec -T postgres psql -U reader -d reader -At -c \
    "SELECT EXISTS (SELECT 1 FROM sync_settings WHERE worker_last_seen_at >= '$worker_started'::timestamptz)")
  if [[ "$fresh" == t ]]; then heartbeat_ready=1; break; fi
  sleep 5
done
[[ "$heartbeat_ready" == 1 ]]
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3100/api/health
printf '%s\n' "$revision" > "$root/current-revision.tmp"
mv "$root/current-revision.tmp" "$root/current-revision"
printf '\nDeployed %s\n' "$revision"
compose ps
