#!/usr/bin/env bash
# Daily online PostgreSQL backup; never removes deployment rollback backups.
set -Eeuo pipefail
umask 077
root=${ELEPHANT_ROOT:-/opt/elephant}
mkdir -p "$root/backups/daily"
exec 9>"$root/deploy.lock"
flock -w 1800 9
target="$root/backups/daily/$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary=$(mktemp "$root/backups/daily/.pending.XXXXXX")
trap 'rm -f "$temporary"' EXIT
docker exec elephant-postgres-1 pg_dump -U reader -d reader --format=custom > "$temporary"
test -s "$temporary"
# Validate the archive directory before publishing it or pruning old backups.
docker exec -i elephant-postgres-1 pg_restore --list < "$temporary" > /dev/null
mv "$temporary" "$target"
find "$root/backups/daily" -maxdepth 1 -type f -name '*.dump' -mtime +29 -delete
printf 'Daily database backup completed; retention 30 days.\n'
