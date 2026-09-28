#!/usr/bin/env bash
# Stops DubRoom gracefully (§21.4): no new rooms, running rounds finish (≤ DRAIN_SECONDS, 5 min),
# then everything stops.
#
#   sudo ./scripts/stop.sh [--yes] [--force] [--maintenance]
#     --force        stop immediately
#     --maintenance  keep the site up with a 503 "under maintenance" page (incident runbook, §22.11);
#                    start.sh removes it
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

FORCE=0
MAINT=0
for a in "$@"; do
  case $a in
    -y | --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --maintenance) MAINT=1 ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done
need docker
load_env

if [[ $MAINT == 1 ]]; then
  install -o 10001 -g 10001 -m 644 /dev/null "${DATA_DIR}/public/maintenance"
  ok "режим обслуживания включён: сайт отвечает 503"
  compose stop -t 10 game-server api media-worker
  ok "игровые сервисы остановлены (caddy и туннель работают)"
  exit 0
fi

if [[ $FORCE == 1 ]]; then
  compose stop -t 10
else
  # SIGTERM → game-server drains (no new rooms, waits for running rounds up to DRAIN_SECONDS)
  step "Ждём окончания текущих раундов (до ${DRAIN_SECONDS:-300} с, --force чтобы не ждать)"
  compose stop -t "$((${DRAIN_SECONDS:-300} + 30))" game-server
  compose stop -t 30
fi
ok "DubRoom остановлен"
