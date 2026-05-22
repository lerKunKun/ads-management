#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
API_SERVICE="${API_SERVICE:-ads-api}"
WORKER_SERVICE="${WORKER_SERVICE:-ads-worker}"
BUILD_WEB="${BUILD_WEB:-1}"
RESTORE_DB="${RESTORE_DB:-0}"
ENV_FILE="${ENV_FILE:-/etc/ads-management/ads.env}"

DEPLOY_DIR="$APP_DIR/.deploy"
BACKUP_DIR="$DEPLOY_DIR/backups"
FAILED_BACKUP="$BACKUP_DIR/failed-$(date +%Y%m%d%H%M%S).tar.gz"

log() {
  printf '[rollback] %s\n' "$*"
}

load_env_file() {
  if [ -r "$ENV_FILE" ]; then
    log "load env file: $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    return 0
  fi
  if [ -f "$ENV_FILE" ] && command -v sudo >/dev/null 2>&1; then
    log "load env file via sudo: $ENV_FILE"
    local tmp_env
    tmp_env="$(mktemp)"
    sudo cat "$ENV_FILE" > "$tmp_env"
    set -a
    # shellcheck disable=SC1090
    . "$tmp_env"
    set +a
    rm -f "$tmp_env"
  fi
}

restart_service() {
  local service="$1"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$service.service" >/dev/null 2>&1; then
    sudo systemctl daemon-reload
    log "restart systemd service: $service"
    sudo systemctl restart "$service"
    return 0
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$service" >/dev/null 2>&1; then
    log "restart pm2 process: $service"
    pm2 restart "$service"
    pm2 save >/dev/null 2>&1 || true
    return 0
  fi
  log "service not found, skip restart: $service"
}

database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s\n' "$DATABASE_URL"
    return 0
  fi
  if [ -f "$APP_DIR/.env" ]; then
    grep -E '^DATABASE_URL=' "$APP_DIR/.env" | tail -n 1 | cut -d= -f2-
  fi
}

restore_database_if_requested() {
  if [ "$RESTORE_DB" != "1" ]; then
    return 0
  fi
  local db_backup
  db_backup="$(ls -1t "$BACKUP_DIR"/db-before-*.dump 2>/dev/null | head -n 1 || true)"
  if [ -z "$db_backup" ]; then
    echo "RESTORE_DB=1 but no db backup found in $BACKUP_DIR" >&2
    exit 1
  fi
  local url
  url="$(database_url)"
  if [ -z "$url" ]; then
    echo "RESTORE_DB=1 but DATABASE_URL not found" >&2
    exit 1
  fi
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "RESTORE_DB=1 but pg_restore not found" >&2
    exit 1
  fi
  log "restore database -> $db_backup"
  pg_restore --dbname "$url" --clean --if-exists "$db_backup"
}

clean_app_dir() {
  find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name '.deploy' \
    ! -name '.data' \
    ! -name '.env' \
    ! -name '.git' \
    ! -name 'logs' \
    ! -name '.logs' \
    ! -name 'node_modules' \
    ! -name 'docker-compose.prod.yml' \
    -exec rm -rf {} +
}

latest_backup="$(ls -1t "$BACKUP_DIR"/before-*.tar.gz 2>/dev/null | head -n 1 || true)"
if [ -z "$latest_backup" ]; then
  echo "no rollback backup found in $BACKUP_DIR" >&2
  exit 1
fi

load_env_file
cd "$APP_DIR"
log "backup failed/current version -> $FAILED_BACKUP"
tar \
  --exclude='./.deploy/incoming' \
  --exclude='./.deploy/backups' \
  --exclude='./.data' \
  --exclude='./node_modules' \
  --exclude='./logs' \
  --exclude='./.logs' \
  --exclude='./.git' \
  -czf "$FAILED_BACKUP" .

log "restore $latest_backup"
clean_app_dir
tar -xzf "$latest_backup" -C "$APP_DIR"
restore_database_if_requested

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed on server" >&2
  exit 1
fi

log "install dependencies"
bun install --frozen-lockfile

if [ "$BUILD_WEB" = "1" ]; then
  log "build web"
  bun --cwd apps/web build
fi

restart_service "$API_SERVICE"
restart_service "$WORKER_SERVICE"

if command -v curl >/dev/null 2>&1; then
  API_PORT="${API_PORT:-3001}"
  log "health check http://127.0.0.1:$API_PORT/health"
  curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null || {
    echo "health check failed after rollback" >&2
    exit 1
  }
fi

log "rollback done"
