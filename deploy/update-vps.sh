#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE=${1:?Usage: update-vps.sh /tmp/valhem-server.tar.gz}
ROOT=/opt/valhem
APP="$ROOT/app"
BACKUPS="$ROOT/backups"
NPM_CACHE="$ROOT/.npm-cache"
STAGE=$(mktemp -d "$ROOT/.deploy.XXXXXX")
BACKUP=""
SWAPPED=0

cleanup() {
  local status=$?

  if (( status != 0 && SWAPPED == 1 )); then
    echo "Deployment failed; restoring previous server release" >&2
    systemctl stop valhem-online.service || true
    rm -rf -- "$APP"
    mv -- "$BACKUP" "$APP"
    systemctl start valhem-online.service || true
  fi

  if [[ -d "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
  rm -f -- "$ARCHIVE"
  case "$0" in
    /tmp/valhem-update-*.sh) rm -f -- "$0" ;;
  esac
  exit "$status"
}
trap cleanup EXIT

[[ -d "$ROOT" ]] || { echo "Missing $ROOT" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "Missing $APP" >&2; exit 1; }
[[ -f "$ARCHIVE" ]] || { echo "Missing deployment archive" >&2; exit 1; }

tar -xzf "$ARCHIVE" -C "$STAGE"
[[ -f "$STAGE/package.json" ]] || { echo "Invalid deployment archive" >&2; exit 1; }
[[ -f "$STAGE/src/server.js" ]] || { echo "Server entry point is missing" >&2; exit 1; }

cd "$STAGE"
npm ci --omit=dev --cache "$NPM_CACHE"
npm test
chown -R valhem:valhem "$STAGE"
chmod -R go-w "$STAGE"

BACKUP="$BACKUPS/app-before-deploy-$(date -u +%Y%m%d-%H%M%S)"
systemctl stop valhem-online.service
mv -- "$APP" "$BACKUP"
SWAPPED=1
mv -- "$STAGE" "$APP"

systemctl start valhem-online.service
for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8080/api/health >/dev/null; then
    break
  fi
  sleep 0.5
done

curl --fail --silent http://127.0.0.1:8080/api/health >/dev/null
systemctl is-active --quiet valhem-online.service
SWAPPED=0
echo "VALHEM VPS deployment completed successfully"
