#!/usr/bin/env bash
set -euo pipefail

# Historical upstream deployment. PMtest has no authorized Linux target.
printf '%s\n' 'WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.' >&2
exit 78

domain="${1:-pm.pengmanager.com}"
template="${2:-/opt/workloom-pm/current/deploy/linux/nginx-workloom-pm.conf}"
[[ "$(id -u)" == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ -f "$template" ]] || { printf 'Nginx template missing: %s\n' "$template" >&2; exit 1; }
install -d -m 0755 /var/www/letsencrypt

challenge="/etc/nginx/sites-available/workloom-pm-acme-$domain.conf"
cat > "$challenge" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 503; }
}
EOF
ln -sfn "$challenge" "/etc/nginx/sites-enabled/workloom-pm-acme-$domain.conf"
nginx -t
systemctl reload nginx

if [[ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  certbot certonly --webroot -w /var/www/letsencrypt -d "$domain" --non-interactive
fi
sed "s/pm\\.pengmanager\\.com/$domain/g" "$template" > "/etc/nginx/sites-available/workloom-pm-$domain.conf"
chmod 0644 "/etc/nginx/sites-available/workloom-pm-$domain.conf"
ln -sfn "/etc/nginx/sites-available/workloom-pm-$domain.conf" "/etc/nginx/sites-enabled/workloom-pm-$domain.conf"
rm -f "/etc/nginx/sites-enabled/workloom-pm-acme-$domain.conf"
nginx -t
systemctl reload nginx
printf 'Nginx configured for %s without changing PengManager routes.\n' "$domain"
