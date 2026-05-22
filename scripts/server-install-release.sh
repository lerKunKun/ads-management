#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/ads-management}"
RELEASE_ID="${RELEASE_ID:?RELEASE_ID is required}"
ARCHIVE="${ARCHIVE:-$APP_DIR/.deploy/incoming/$RELEASE_ID.tar.gz}"
API_SERVICE="${API_SERVICE:-ads-api}"
WORKER_SERVICE="${WORKER_SERVICE:-ads-worker}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
BUILD_WEB="${BUILD_WEB:-1}"
ENV_FILE="${ENV_FILE:-/etc/ads-management/ads.env}"

DEPLOY_DIR="$APP_DIR/.deploy"
BACKUP_DIR="$DEPLOY_DIR/backups"
PRESERVE_DIR="$DEPLOY_DIR/preserve-$RELEASE_ID"
BACKUP_FILE="$BACKUP_DIR/before-$RELEASE_ID.tar.gz"

log() {
  printf '[deploy] %s\n' "$*"
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

backup_database() {
  local url
  url="$(database_url)"
  if [ -z "$url" ]; then
    log "DATABASE_URL not found, skip database backup"
    return 0
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    if command -v docker >/dev/null 2>&1 && sudo docker ps --format '{{.Names}}' | grep -qx 'ads_pg'; then
      local db_backup="$BACKUP_DIR/db-before-$RELEASE_ID.dump"
      log "backup database via ads_pg container -> $db_backup"
      sudo docker exec ads_pg pg_dump -U ads -d ads --format=custom > "$db_backup"
      return 0
    fi
    log "pg_dump not found, skip database backup"
    return 0
  fi
  local db_backup="$BACKUP_DIR/db-before-$RELEASE_ID.dump"
  log "backup database -> $db_backup"
  pg_dump --dbname "$url" --format=custom --file "$db_backup"
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

if [ ! -f "$ARCHIVE" ]; then
  echo "archive not found: $ARCHIVE" >&2
  exit 1
fi

load_env_file
mkdir -p "$APP_DIR" "$DEPLOY_DIR/incoming" "$BACKUP_DIR" "$PRESERVE_DIR"
cd "$APP_DIR"

if [ -f "$APP_DIR/package.json" ]; then
  log "backup current version -> $BACKUP_FILE"
  tar \
    --exclude='./.deploy/incoming' \
    --exclude='./.deploy/backups' \
    --exclude='./.data' \
    --exclude='./node_modules' \
    --exclude='./logs' \
    --exclude='./.logs' \
    --exclude='./.git' \
    -czf "$BACKUP_FILE" .
else
  log "no existing package.json, first deploy backup marker only"
  touch "$BACKUP_DIR/before-$RELEASE_ID.empty"
fi

if [ -f "$APP_DIR/.env" ]; then
  cp -a "$APP_DIR/.env" "$PRESERVE_DIR/.env"
fi

log "replace application files"
clean_app_dir
tar -xzf "$ARCHIVE" -C "$APP_DIR"

if [ -f "$PRESERVE_DIR/.env" ]; then
  cp -a "$PRESERVE_DIR/.env" "$APP_DIR/.env"
fi

if [ -f "$APP_DIR/scripts/server-rollback-last.sh" ]; then
  cp "$APP_DIR/scripts/server-rollback-last.sh" "$APP_DIR/rollback-last.sh"
  chmod +x "$APP_DIR/rollback-last.sh"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed on server" >&2
  exit 1
fi

log "install dependencies"
bun install --frozen-lockfile

if [ "$RUN_MIGRATIONS" = "1" ]; then
  backup_database
  log "run database migrations"
  bun --cwd packages/db migrate
fi

if [ "$BUILD_WEB" = "1" ]; then
  log "build web"
  bun --cwd apps/web build
fi

restart_service "$API_SERVICE"
restart_service "$WORKER_SERVICE"

if command -v curl >/dev/null 2>&1; then
  API_PORT="${API_PORT:-3001}"
  log "health check http://127.0.0.1:$API_PORT/health"
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "health check failed; old version backup: $BACKUP_FILE" >&2
    exit 1
  fi
fi

printf '%s\n' "$RELEASE_ID" > "$DEPLOY_DIR/current-release"
log "done release=$RELEASE_ID"
log "rollback command: cd $APP_DIR && ./rollback-last.sh"
