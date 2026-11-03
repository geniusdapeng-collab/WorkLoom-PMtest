#!/usr/bin/env bash
set -euo pipefail

# Historical upstream deployment. PMtest has no authorized Linux target.
printf '%s\n' 'WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.' >&2
exit 78
umask 077

domain="pm.pengmanager.com"
sha="${WORKLOOM_RELEASE_SHA:-}"
repo_url="https://github.com/geniusdapeng-collab/workloom-pm"
root="/opt/workloom-pm"
data_root="/var/lib/workloom-pm"
config_root="/etc/workloom-pm"
runtime_env="$config_root/runtime.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --sha) sha="$2"; shift 2 ;;
    --repo) repo_url="$2"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ "$(id -u)" == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { printf 'A full 40-character main SHA is required via --sha.\n' >&2; exit 1; }
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { printf 'Invalid domain.\n' >&2; exit 1; }

if [[ ! -f /etc/os-release ]]; then printf '/etc/os-release missing.\n' >&2; exit 1; fi
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] || { printf 'Ubuntu/Debian is required.\n' >&2; exit 1; }
arch="$(uname -m)"
case "$arch" in x86_64) runtime_arch="x64" ;; aarch64|arm64) runtime_arch="arm64" ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; exit 1 ;; esac

database_url() {
  (
    export DB_URL_USER="$1"
    export DB_URL_PASSWORD="$2"
    export DB_URL_NAME="$3"
    export DB_URL_HOST="${4:-127.0.0.1}"
    export DB_URL_PORT="${5:-5432}"
    export DB_URL_SOCKET="${6:-}"
    exec "$root/runtime/current/bin/node" -e '
      const url = new URL("postgresql://localhost");
      url.username = process.env.DB_URL_USER;
      url.password = process.env.DB_URL_PASSWORD;
      if (process.env.DB_URL_SOCKET) {
        url.host = "";
        url.searchParams.set("host", process.env.DB_URL_SOCKET);
      } else {
        url.hostname = process.env.DB_URL_HOST;
        url.port = process.env.DB_URL_PORT;
      }
      url.pathname = `/${process.env.DB_URL_NAME}`;
      process.stdout.write(url.href);
    '
  )
}

database_password_from_runtime_env() {
  "$root/runtime/current/bin/node" -e '
    const fs = require("node:fs");
    const [file, key] = process.argv.slice(1);
    const prefix = `${key}=`;
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((item) => item.startsWith(prefix));
    if (!line) throw new Error(`现有运行时配置缺少 ${key}`);
    const url = new URL(line.slice(prefix.length));
    if (!url.password) throw new Error(`${key} 缺少数据库密码`);
    process.stdout.write(decodeURIComponent(url.password));
  ' "$runtime_env" "$1"
}

mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
disk_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
if (( mem_kb < 1500000 )); then printf 'At least 1.5 GiB RAM is required for preflight; current %s KiB.\n' "$mem_kb" >&2; exit 1; fi
if (( disk_kb < 6000000 )); then printf 'At least 6 GiB free under /opt is required; current %s KiB.\n' "$disk_kb" >&2; exit 1; fi

apt-get update
apt-get install -y ca-certificates curl xz-utils jq git apparmor bubblewrap nginx certbot python3-certbot-nginx postgresql-common

if ! command -v psql >/dev/null || [[ "$(psql --version | awk '{print $3}' | cut -d. -f1)" != 17 ]]; then
  codename="${VERSION_CODENAME:-}"
  [[ "$codename" == "noble" || "$codename" == "jammy" ]] || codename="noble"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  printf 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$codename" > /etc/apt/sources.list.d/pgdg.list
  apt-get update
  apt-get install -y postgresql-17
fi
apt-get install -y postgresql-17-pgvector
systemctl enable --now postgresql

if [[ -d /etc/apparmor.d && "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)" == Y ]]; then
  install -d -m 0755 /etc/apparmor.d/local
  install -m 0644 "$(dirname "$0")/apparmor-bwrap" /etc/apparmor.d/bwrap
  apparmor_parser -r /etc/apparmor.d/bwrap
fi

runtime_json="$(dirname "$0")/runtime.json"
node_version="$(jq -r .nodeVersion "$runtime_json")"
pnpm_version="$(jq -r .pnpmVersion "$runtime_json")"
node_url="$(jq -r --arg arch "$runtime_arch" '.artifacts[$arch].url' "$runtime_json")"
node_sha="$(jq -r --arg arch "$runtime_arch" '.artifacts[$arch].sha256' "$runtime_json")"
node_name="$(basename "$node_url" .tar.xz)"
install -d -m 0755 "$root/runtime" "$root/releases" "$root/tooling" "$config_root" "$data_root"
if [[ ! -x "$root/runtime/current/bin/node" ]]; then
  node_archive="$(mktemp /tmp/workloom-node.XXXXXX.tar.xz)"
  curl -fL "$node_url" -o "$node_archive"
  printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum -c -
  tar -C "$root/runtime" -xJf "$node_archive"
  ln -sfn "$node_name" "$root/runtime/current"
  rm -f "$node_archive"
fi
if [[ ! -x "$root/tooling/bin/pnpm" ]]; then
  env -i PATH="$root/runtime/current/bin:/usr/bin:/bin" HOME="$root/tooling" NPM_CONFIG_USERCONFIG=/dev/null \
    "$root/runtime/current/bin/npm" install --global --prefix "$root/tooling" "pnpm@$pnpm_version"
fi

if ! id workloom-pm >/dev/null 2>&1; then
  useradd --system --home "$data_root" --shell /usr/sbin/nologin --user-group workloom-pm
fi
# The postgres OS user runs the reviewed bootstrap and migration scripts from
# inside the immutable release, so /opt ancestors and release files must remain
# traverse/readable. Application data stays private at 0750.
install -d -m 0750 -o workloom-pm -g workloom-pm "$data_root"
install -d -m 0755 -o root -g root "$root/releases"
install -d -m 0700 -o root -g root "$config_root"
install -d -m 0755 -o root -g root /var/www/letsencrypt

if [[ -f "$runtime_env" ]]; then
  # Reinstalls must reuse the credentials already embedded in runtime.env.
  # Generating new passwords while leaving the old URLs in place rotates roles
  # underneath the running service and causes authentication drift.
  owner_password="$(database_password_from_runtime_env DATABASE_URL)"
  app_password="$(database_password_from_runtime_env DATABASE_APP_URL)"
  gateway_password="$(database_password_from_runtime_env DATABASE_GATEWAY_URL)"
else
  owner_password="${WORKLOOM_OWNER_PASSWORD:-$(openssl rand -hex 32)}"
  app_password="${APP_DB_PASSWORD:-$(openssl rand -hex 32)}"
  gateway_password="${GATEWAY_DB_PASSWORD:-$(openssl rand -hex 32)}"
fi
jwt_secret="${JWT_SECRET:-$(openssl rand -hex 48)}"
pii_salt="${PII_SALT:-$(openssl rand -hex 32)}"
service_secret="${SERVICE_C_SECRET:-$(openssl rand -hex 32)}"
[[ -n "${DEEPSEEK_API_KEY:-}" ]] || { printf 'DEEPSEEK_API_KEY must be injected in the install process environment.\n' >&2; exit 1; }
[[ -n "${WORKLOOM_LAUNCH_PUBLIC_KEY_B64:-}" ]] || { printf 'WORKLOOM_LAUNCH_PUBLIC_KEY_B64 must be injected.\n' >&2; exit 1; }

if [[ ! -f "$runtime_env" ]]; then
  install -m 0600 /dev/null "$runtime_env"
  node_url_owner="$(database_url workloom_owner "$owner_password" workloom_pm)"
  node_url_app="$(database_url workloom_app "$app_password" workloom_pm)"
  node_url_gateway="$(database_url workloom_gateway "$gateway_password" workloom_pm)"
  {
    printf 'NODE_ENV=production\n'
    printf 'SERVER_HOST=127.0.0.1\nSERVER_PORT=8988\nWEB_PORT=5373\n'
    printf 'DATABASE_URL=%s\nDATABASE_APP_URL=%s\nDATABASE_GATEWAY_URL=%s\n' "$node_url_owner" "$node_url_app" "$node_url_gateway"
    printf 'JWT_SECRET=%s\nPII_SALT=%s\n' "$jwt_secret" "$pii_salt"
    printf 'LLM_PROVIDER=deepseek\nLLM_BASE_URL=https://api.deepseek.com\nLLM_MODEL=deepseek-flash\n'
    printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"
    printf 'ASSISTANT_PUBLIC_ORIGIN=https://%s\n' "$domain"
    printf 'ASSISTANT_DAILY_CALL_LIMIT=300\nASSISTANT_DAILY_TOKEN_LIMIT=2000000\nASSISTANT_DAILY_SEARCH_LIMIT=100\n'
    printf 'WORKLOOM_LAUNCH_PUBLIC_KEY_B64=%s\n' "$WORKLOOM_LAUNCH_PUBLIC_KEY_B64"
    printf 'PM_SANDBOX_ROOT=%s/pm-sandbox\nWORKLOOM_SUPPORT_DIR=%s\n' "$data_root" "$data_root"
    printf 'PM_LINUX_SANDBOX_BIN=/usr/bin/bwrap\nEVENT_BUS=memory\n'
    printf 'SERVICE_C_SECRET=%s\nSERVICE_C_DEMO_AUTH=false\n' "$service_secret"
  } > "$runtime_env"
  chmod 0600 "$runtime_env"
fi

release="$root/releases/$sha"
if [[ ! -d "$release" ]]; then
  archive="$(mktemp /tmp/workloom-release.XXXXXX.tar.gz)"
  curl -fL "$repo_url/archive/$sha.tar.gz" -o "$archive"
  tar -xzf "$archive" -C "$root/releases"
  extracted="$root/releases/workloom-pm-$sha"
  [[ -d "$extracted" ]] || { printf 'Release archive layout is invalid.\n' >&2; exit 1; }
  mv "$extracted" "$release"
  rm -f "$archive"
fi
chown -R workloom-pm:workloom-pm "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -perm /111 -exec chmod 0755 {} +
find "$release" -type f ! -perm /111 -exec chmod 0644 {} +

export PATH="$root/runtime/current/bin:$root/tooling/bin:/usr/sbin:/sbin:/usr/bin:/bin"
if command -v bwrap >/dev/null 2>&1; then
  runuser -u workloom-pm -- bwrap --unshare-all --ro-bind / / true >/dev/null
fi
runuser -u workloom-pm -- env HOME="$data_root" PATH="$PATH" \
  "$root/tooling/bin/pnpm" -C "$release" install --frozen-lockfile --prod=false
find "$release/node_modules" -type d -exec chmod 0755 {} +
find "$release/node_modules" -type f ! -perm /111 -exec chmod 0644 {} +
runuser -u workloom-pm -- env HOME="$data_root" PATH="$PATH" \
  "$root/tooling/bin/pnpm" -C "$release/apps/web" build
find "$release/apps/web/dist" -type d -exec chmod 0755 {} +
find "$release/apps/web/dist" -type f -exec chmod 0644 {} +

WORKLOOM_OWNER_PASSWORD="$owner_password" APP_DB_PASSWORD="$app_password" GATEWAY_DB_PASSWORD="$gateway_password" \
  runuser -u postgres --preserve-environment -- "$root/runtime/current/bin/node" "$release/deploy/linux/bootstrap-db.mjs"

migration_url="$(database_url postgres "" workloom_pm 127.0.0.1 5432 /var/run/postgresql)"
owner_url="$(database_url workloom_owner "$owner_password" workloom_pm)"
app_url="$(database_url workloom_app "$app_password" workloom_pm)"
gateway_url="$(database_url workloom_gateway "$gateway_password" workloom_pm)"
DATABASE_URL="$migration_url" APP_DB_PASSWORD="$app_password" GATEWAY_DB_PASSWORD="$gateway_password" NODE_ENV=production \
  runuser -u postgres --preserve-environment -- \
  "$root/runtime/current/bin/node" "$release/node_modules/tsx/dist/cli.mjs" "$release/scripts/migrate.ts"

DATABASE_URL="$owner_url" DATABASE_APP_URL="$app_url" DATABASE_GATEWAY_URL="$gateway_url" NODE_ENV=production LLM_PROVIDER=mock \
  runuser -u workloom-pm --preserve-environment -- \
  "$root/runtime/current/bin/node" "$release/node_modules/tsx/dist/cli.mjs" "$release/scripts/seed-aipm.ts"

ln -sfn "$release" "$root/current"
install -m 0755 "$release/deploy/linux/start.sh" "$root/start.sh"
install -m 0644 "$release/deploy/linux/workloom-pm.service" /etc/systemd/system/workloom-pm.service
systemctl daemon-reload
systemctl enable workloom-pm.service
systemctl restart workloom-pm.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8988/api/assistant/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8988/api/assistant/health >/dev/null
printf 'WorkLoom PM release %s is installed; Nginx TLS is a separate reviewed step.\n' "$sha"
