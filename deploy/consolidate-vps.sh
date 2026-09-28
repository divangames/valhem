#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/valhem
APP="$ROOT/app"
CONFIG="$ROOT/config"
DATA="$ROOT/data"
BACKUP="$ROOT/backups/pre-consolidation-20260929"

OLD_APP=/opt/valhem-online
OLD_DATA=/var/lib/valhem-online
OLD_ENV=/etc/valhem-online.env
SYSTEMD_LINK=/etc/systemd/system/valhem-online.service
NGINX_LINK=/etc/nginx/snippets/valhem-online.conf

if [[ -e "$ROOT" ]]; then
  echo "Refusing to overwrite existing $ROOT" >&2
  exit 1
fi

mkdir -p "$APP" "$CONFIG" "$DATA" "$BACKUP"
cp -a "$OLD_APP/." "$APP/"
cp -a "$OLD_ENV" "$CONFIG/valhem.env"
cp -a "$SYSTEMD_LINK" "$CONFIG/valhem-online.service"
cp -a "$NGINX_LINK" "$CONFIG/valhem-online.nginx.conf"

cp -a "$OLD_ENV" "$BACKUP/valhem-online.env"
cp -a "$SYSTEMD_LINK" "$BACKUP/valhem-online.service"
cp -a "$NGINX_LINK" "$BACKUP/valhem-online.nginx.conf"

sed -i 's#^DATA_DIR=.*#DATA_DIR=/opt/valhem/data#' "$CONFIG/valhem.env"
sed -i \
  -e 's#WorkingDirectory=/opt/valhem-online#WorkingDirectory=/opt/valhem/app#' \
  -e 's#EnvironmentFile=/etc/valhem-online.env#EnvironmentFile=/opt/valhem/config/valhem.env#' \
  -e 's#ReadWritePaths=/var/lib/valhem-online#ReadWritePaths=/opt/valhem/data#' \
  "$CONFIG/valhem-online.service"

systemctl stop valhem-online.service
cp -a "$OLD_DATA/." "$DATA/"

chown -R valhem:valhem "$APP" "$DATA"
chown root:valhem "$CONFIG/valhem.env"
chmod 640 "$CONFIG/valhem.env"
chmod 755 "$ROOT" "$CONFIG" "$ROOT/backups"
chmod 750 "$DATA"

rm -f "$SYSTEMD_LINK" "$NGINX_LINK" "$OLD_ENV"
ln -s "$CONFIG/valhem-online.service" "$SYSTEMD_LINK"
ln -s "$CONFIG/valhem-online.nginx.conf" "$NGINX_LINK"
ln -s "$CONFIG/valhem.env" "$OLD_ENV"

systemctl daemon-reload
nginx -t
systemctl start valhem-online.service

for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8080/api/health >/dev/null; then
    break
  fi
  sleep 0.5
done

curl --fail --silent http://127.0.0.1:8080/api/health >/dev/null
systemctl is-active --quiet valhem-online.service

mv "$OLD_APP" "$BACKUP/legacy-app"
mv "$OLD_DATA" "$BACKUP/legacy-data"
usermod --home "$ROOT" valhem

echo "VALHEM consolidated under $ROOT"
