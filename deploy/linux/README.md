> **Historical upstream reference.** PMtest uses the source setup in
> [the repository README](../../README.md). Its inherited Linux entrypoints
> reject execution. The service unit and Nginx configuration below name the
> original WorkLoom PM deployment and must not be installed for PMtest.

# WorkLoom PM Linux deployment

This deployment keeps WorkLoom PM independent from PengManager:

- WorkLoom PM runs as `workloom-pm` and listens only on `127.0.0.1:8988`.
- PostgreSQL database `workloom_pm` is separate from PengManager state.
- Nginx serves the React build and proxies `/api/assistant`, `/trpc`, `/health`, and
  `/app/c`.
- The DeepSeek key and launch public key live only in
  `/etc/workloom-pm/runtime.env` (`0600`).
- DeepSeek Search uses the same server-side credential and has a separate
  `ASSISTANT_DAILY_SEARCH_LIMIT` hard budget (default 100 calls/day).
- Linux code tests run under `bubblewrap` with a private network namespace,
  read-only system mounts, a disposable workspace, and a 30-second wall clock.
- On AppArmor-enabled Ubuntu hosts, the installer loads a narrowly matched
  `/usr/bin/bwrap` user-namespace profile before the sandbox preflight.

## Install

The target must be Ubuntu/Debian, have DNS for `pm.pengmanager.com`, and have
at least 1.5 GiB RAM and 6 GiB free under `/opt`.

Run on the server after the reviewed commit is merged:

```bash
sudo DEEPSEEK_API_KEY=... WORKLOOM_LAUNCH_PUBLIC_KEY_B64=... \
bash deploy/linux/install.sh --sha <full-main-sha> --domain pm.pengmanager.com
```

The install script downloads the exact GitHub commit archive, Node 24.22.1 from
the official Node distribution after SHA-256 verification, and pnpm 10.14.0.
It does not replace the host Node installation.
It installs the reviewed Bubblewrap profile and fails before activation if a
namespace isolation preflight cannot run.

## TLS and Nginx

Create the DNS A record first. Then run:

```bash
sudo bash deploy/linux/configure-nginx.sh pm.pengmanager.com
```

The script first exposes only the ACME challenge route, then installs the
WorkLoom-specific TLS vhost. It does not edit PengManager's vhost, certificate,
or application.

## Backup and isolated restore

```bash
sudo bash deploy/linux/backup.sh /var/backups/workloom-pm
sudo bash deploy/linux/restore-check.sh \
  /var/backups/workloom-pm/workloom-pm-<timestamp>.tar.gz \
  /var/lib/workloom-pm-restore-check/<timestamp>
```

Backups contain a custom-format PostgreSQL dump, `/var/lib/workloom-pm`, and
non-secret configuration metadata. The live `runtime.env` is excluded by design.
The restore check creates a new database and verifies migration and event table
counts without touching the live database.

## Operational checks

```bash
systemctl status workloom-pm.service
journalctl -u workloom-pm.service --since "10 minutes ago"
curl -fsS http://127.0.0.1:8988/api/assistant/health
curl -fsS https://pm.pengmanager.com/api/assistant/health
nginx -t
```

An HTTP 200 is only a liveness signal. Production acceptance requires a real
admin SSO exchange, a real DeepSeek answer, a real task-mode artifact receipt,
Linux sandbox negative tests, browser screenshots, and the 218-case live
evaluation in `scripts/assistant-218.mjs`.
