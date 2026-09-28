#!/usr/bin/env bash
# Starts DubRoom (§21.4): builds images if needed, `docker compose up -d`, waits for health
# checks, checks the public address and prints the links.
#
#   sudo ./scripts/start.sh [--yes] [--build] [--no-wait]
#     --build    rebuild images even if they exist
#     --no-wait  don't wait for health checks
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

BUILD=0
WAIT=1
for a in "$@"; do
  case $a in
    -y | --yes) ASSUME_YES=1 ;;
    --build) BUILD=1 ;;
    --no-wait) WAIT=0 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done

need docker
load_env
cd "$INSTALL_DIR"

image="${DUBROOM_IMAGE:-dubroom/app}:${DUBROOM_VERSION:-local}"
if [[ $BUILD == 1 ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
  step "Сборка образов ($image)"
  compose build
fi

rm -f "${DATA_DIR}/public/maintenance"
step "Запуск"
compose up -d --remove-orphans

if [[ $WAIT == 1 ]]; then
  for i in $(seq 1 90); do
    unhealthy=$(compose ps --format '{{.Service}} {{.Health}}' | awk '$2 != "" && $2 != "healthy" {print $1}' | sort -u)
    [[ -z $unhealthy ]] && break
    ((i == 90)) && die "не поднялись: $unhealthy — ./scripts/logs.sh <сервис>"
    sleep 2
  done
  while read -r svc health; do ok "$svc${health:+ ($health)}"; done < <(compose ps --format '{{.Service}} {{.Health}}' | sort -u)
fi

if [[ ${TUNNEL_MODE:-} == quick ]]; then
  for _ in $(seq 1 30); do
    url=$(compose logs cloudflared 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
    [[ -n $url ]] && break
    sleep 2
  done
  [[ -n ${url:-} ]] && env_set "$ENV_FILE" PUBLIC_URL "$url"
  PUBLIC_URL=${url:-}
fi

if [[ -n ${PUBLIC_URL:-} && ${PUBLIC_URL} == https://* ]]; then
  if wait_http "${PUBLIC_URL}/api/health" 60; then ok "публичный адрес отвечает"; else warn "${PUBLIC_URL} пока не отвечает — проверьте туннель: ./scripts/tunnel.sh info"; fi
fi
printf '\n'
info "Игра:        ${PUBLIC_URL:-http://localhost:8080}"
info "Clip Studio: ${STUDIO_URL:-http://studio.localhost:8080}"
