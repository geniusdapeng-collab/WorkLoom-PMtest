#!/usr/bin/env bash
set -euo pipefail

# Historical upstream deployment. PMtest has no authorized Linux target.
printf '%s\n' 'WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.' >&2
exit 78

archive="${1:-}"
target="${2:-/var/lib/workloom-pm-restore-check}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  printf 'Usage: %s <backup.tar.gz> [empty-restore-directory]\n' "$0" >&2
  exit 1
fi
if [[ "$target" != /var/lib/workloom-pm-restore-* ]]; then
  printf 'Restore target must start /var/lib/workloom-pm-restore-\n' >&2
  exit 1
fi
if [[ -e "$target" ]] && [[ -n "$(ls -A "$target" 2>/dev/null)" ]]; then
  printf 'Restore target is not empty: %s\n' "$target" >&2
  exit 1
fi

install -d -m 0750 -o root -g postgres "$target"
tar -C "$target" -xzf "$archive"
chown root:postgres "$target/database.dump"
chmod 0640 "$target/database.dump"
chmod 0600 "$target/data.tar.gz" "$target/config-hashes.tar.gz"
db_name="workloom_pm_restore_check_$(date -u +%Y%m%d%H%M%S)"
runuser -u postgres -- createdb -h /var/run/postgresql "$db_name"
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$db_name" "$target/database.dump"
rows="$(runuser -u postgres -- psql -At -d "$db_name" -c 'SELECT count(*) FROM _migrations;')"
events="$(runuser -u postgres -- psql -At -d "$db_name" -c 'SELECT count(*) FROM biz_events;')"
printf 'Isolated restore verified: database=%s migrations=%s events=%s data=%s\n' "$db_name" "$rows" "$events" "$target"
