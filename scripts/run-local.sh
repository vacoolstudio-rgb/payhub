#!/usr/bin/env bash
# Runs one compiled service with the right per-service environment.
#
#   npm run build
#   ./scripts/run-local.sh ledger
#
# Infrastructure first: `docker compose up -d postgres redis kafka`.
set -euo pipefail

service="${1:?usage: run-local.sh <api|ledger|worker|notifications>}"

set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a

case "$service" in
  api)
    export SERVICE_NAME=payhub-api PORT=${API_PORT:-3000} DATABASE_SCHEMA=payhub \
           KAFKA_CONSUMER_GROUP=payhub-api DATABASE_RUN_MIGRATIONS=true
    ;;
  ledger)
    export SERVICE_NAME=payhub-ledger PORT=${LEDGER_PORT:-3001} DATABASE_SCHEMA=ledger \
           KAFKA_CONSUMER_GROUP=payhub-ledger DATABASE_RUN_MIGRATIONS=true
    ;;
  worker)
    export SERVICE_NAME=payhub-worker PORT=${WORKER_PORT:-3002} DATABASE_SCHEMA=payhub \
           KAFKA_CONSUMER_GROUP=payhub-worker DATABASE_RUN_MIGRATIONS=false
    ;;
  notifications)
    export SERVICE_NAME=payhub-notifications PORT=${NOTIFICATIONS_PORT:-3003} \
           KAFKA_CONSUMER_GROUP=payhub DATABASE_RUN_MIGRATIONS=false
    ;;
  *)
    echo "unknown service: $service" >&2
    exit 1
    ;;
esac

exec node --enable-source-maps "dist/apps/${service}/src/main.js"
