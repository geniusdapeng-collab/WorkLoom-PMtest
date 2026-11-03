#!/usr/bin/env bash
set -euo pipefail

# Historical upstream deployment. PMtest has no authorized Linux target.
printf '%s\n' 'WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.' >&2
exit 78

dest="${1:-/var/backups/workloom-pm}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$dest/workloom-pm-$stamp.tar.gz"

install -d -m 0700 -o workloom-pm -g workloom-pm "$dest"
work="$(mktemp -d "${TMPDIR:-/tmp}/workloom-pm-backup.XXXXXX")"
restart=0
if systemctl is-active --quiet workloom-pm.service; then
  systemctl stop workloom-pm.service
  restart=1
fi
cleanup() {
  [[ -d "$work" ]] && rm -rf "$work"
  if [[ "$restart" == 1 ]]; then systemctl start workloom-pm.service || true; fi
}
trap cleanup EXIT

runuser -u postgres -- pg_dump --format=custom --no-owner --no-privileges workloom_pm > "$work/database.dump"
tar -C /var/lib/workloom-pm -czf "$work/data.tar.gz" .
tar -C /etc/workloom-pm -czf "$work/config-hashes.tar.gz" --exclude=runtime.env .
tar -C "$work" -czf "$archive" database.dump data.tar.gz config-hashes.tar.gz
chown workloom-pm:workloom-pm "$archive"
chmod 0600 "$archive"
sha256sum "$archive" > "$archive.sha256"
chown workloom-pm:workloom-pm "$archive.sha256"
chmod 0600 "$archive.sha256"
printf '%s\n' "$archive"
