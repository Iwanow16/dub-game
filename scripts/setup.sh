#!/usr/bin/env bash
# Interactive setup wizard (§21.4, §21.5): domain, tunnel mode, secrets, .env, data directory,
# autostart and scheduled jobs. Keeps existing values — re-running changes nothing that works.
#
#   sudo ./scripts/setup.sh [--yes] [--no-harden]
#
# Non-interactive: pass values as environment variables, e.g.
#   DOMAIN=example.com TUNNEL_MODE=token TUNNEL_TOKEN=… sudo -E ./scripts/setup.sh --yes
# TUNNEL_MODE: token (A, recommended) | local (B) | quick (C, demo only) | none (local only)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

HARDEN=ask
for a in "$@"; do
  case $a in
    -y | --yes) ASSUME_YES=1 ;;
    --no-harden) HARDEN=no ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done

require_root
need openssl docker
ENV_FILE="$INSTALL_DIR/.env"
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# existing values win over prompts (idempotency)
for k in DOMAIN PLAY_HOST STUDIO_HOST TUNNEL_MODE TUNNEL_TOKEN CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD AUTHOR_EMAILS; do
  current=$(env_get "$ENV_FILE" "$k")
  if [[ -z ${!k:-} && -n $current ]]; then printf -v "$k" '%s' "$current"; fi
done

step "Домен и туннель"
ask TUNNEL_MODE "Режим туннеля: token (A, из панели Cloudflare) / local (B) / quick (C, демо) / none" token
case $TUNNEL_MODE in token | local | quick | none) ;; *) die "неизвестный режим: $TUNNEL_MODE" ;; esac

if [[ $TUNNEL_MODE == quick || $TUNNEL_MODE == none ]]; then
  DOMAIN=${DOMAIN:-localhost}
  PLAY_HOST=${PLAY_HOST:-localhost}
  STUDIO_HOST=${STUDIO_HOST:-studio.localhost}
else
  ask DOMAIN "Домен в Cloudflare" example.com
  ask PLAY_HOST "Хостнейм игры" "play.${DOMAIN}"
  ask STUDIO_HOST "Хостнейм Clip Studio" "studio.${DOMAIN}"
fi
if [[ $TUNNEL_MODE == token ]]; then
  ask_secret TUNNEL_TOKEN "TUNNEL_TOKEN (Zero Trust → Networks → Tunnels → Install connector)"
  [[ -n ${TUNNEL_TOKEN:-} ]] || die "TUNNEL_TOKEN обязателен в режиме token"
  TUNNEL_TOKEN=$(clean_tunnel_token "$TUNNEL_TOKEN")
  [[ $TUNNEL_TOKEN =~ ^eyJ[A-Za-z0-9_=+/-]+$ ]] ||
    die "это не похоже на токен туннеля: нужна длинная строка, начинающаяся с eyJ (после --token в команде установки)"
fi
ask AUTHOR_EMAILS "Email-ы авторов Clip Studio для Cloudflare Access (через запятую, можно позже)" ""

step "Конфигурация .env"
set_default() { [[ -n $(env_get "$ENV_FILE" "$1") ]] || env_set "$ENV_FILE" "$1" "$2"; }
env_set "$ENV_FILE" DOMAIN "$DOMAIN"
env_set "$ENV_FILE" PLAY_HOST "$PLAY_HOST"
env_set "$ENV_FILE" STUDIO_HOST "$STUDIO_HOST"
env_set "$ENV_FILE" TUNNEL_MODE "$TUNNEL_MODE"
env_set "$ENV_FILE" AUTHOR_EMAILS "${AUTHOR_EMAILS:-}"
case $TUNNEL_MODE in
  token)
    env_set "$ENV_FILE" TUNNEL_TOKEN "$TUNNEL_TOKEN"
    env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 run"
    env_set "$ENV_FILE" TUNNEL_REPLICAS 2
    env_set "$ENV_FILE" PUBLIC_URL "https://${PLAY_HOST}"
    env_set "$ENV_FILE" STUDIO_URL "https://${STUDIO_HOST}"
    env_set "$ENV_FILE" ALLOWED_ORIGINS "https://${PLAY_HOST}"
    ;;
  local)
    env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 --config /etc/cloudflared/config.yml run"
    env_set "$ENV_FILE" TUNNEL_REPLICAS 2
    env_set "$ENV_FILE" PUBLIC_URL "https://${PLAY_HOST}"
    env_set "$ENV_FILE" STUDIO_URL "https://${STUDIO_HOST}"
    env_set "$ENV_FILE" ALLOWED_ORIGINS "https://${PLAY_HOST}"
    ;;
  quick)
    env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 --url http://caddy:8080"
    env_set "$ENV_FILE" TUNNEL_REPLICAS 1
    # the running tunnel's address stays (start.sh refreshes it)
    [[ $(env_get "$ENV_FILE" PUBLIC_URL) == *.trycloudflare.com ]] || env_set "$ENV_FILE" PUBLIC_URL ""
    env_set "$ENV_FILE" STUDIO_URL "http://studio.localhost:8080 (через ssh -L 8080:127.0.0.1:8080)"
    env_set "$ENV_FILE" ALLOWED_ORIGINS ""
    ;;
  none)
    env_set "$ENV_FILE" PUBLIC_URL "http://localhost:8080"
    env_set "$ENV_FILE" STUDIO_URL "http://studio.localhost:8080"
    env_set "$ENV_FILE" ALLOWED_ORIGINS ""
    ;;
esac
set_default TOKEN_SIGNING_KEY "$(random_secret 64)"
set_default STUDIO_KEY "$(random_secret 24)"
set_default SECRETS_ROTATED_AT "$(date -u +%F)"
set_default DATA_DIR "$INSTALL_DIR/data"
set_default DUBROOM_VERSION "$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo local)"
set_default DUBROOM_IMAGE dubroom/app
set_default DUBROOM_CADDY_IMAGE dubroom/caddy
set_default CLOUDFLARED_VERSION 2025.9.1
set_default TUNNEL_PROTOCOL http2
set_default MAX_ROOMS 500
set_default DRAIN_SECONDS 300
set_default JOB_TIMEOUT_MIN 10
set_default BACKUP_KEEP_DAILY 7
set_default BACKUP_KEEP_WEEKLY 4
ok ".env: $ENV_FILE (права 600, секреты сгенерированы)"

DATA_DIR=$(env_get "$ENV_FILE" DATA_DIR)
mkdir -p "$DATA_DIR"
chown -R 10001:10001 "$DATA_DIR"
ok "данные: $DATA_DIR"

if [[ $TUNNEL_MODE == local && ! -f $INSTALL_DIR/infra/cloudflared/config.yml ]]; then
  step "Туннель (режим B)"
  "$INSTALL_DIR/scripts/tunnel.sh" create --yes
fi

step "Автозапуск и расписание"
if have systemctl && [[ -d /run/systemd/system ]]; then
  sed "s#/opt/dubroom#${INSTALL_DIR}#g" "$INSTALL_DIR/infra/systemd/dubroom.service" >/etc/systemd/system/dubroom.service
  systemctl daemon-reload
  systemctl enable dubroom.service >/dev/null
  ok "systemd: dubroom.service включён (запуск после перезагрузки)"
fi
if [[ -d /etc/cron.d ]]; then
  sed "s#/opt/dubroom#${INSTALL_DIR}#g" "$INSTALL_DIR/infra/cron/dubroom" >/etc/cron.d/dubroom
  chmod 644 /etc/cron.d/dubroom
  ok "cron: бэкап 04:10, status --notify каждые 5 мин, security-check по понедельникам"
fi

if [[ $HARDEN == ask ]] && confirm "Применить базовые настройки безопасности сервера (harden.sh)?"; then HARDEN=yes; fi
if [[ $HARDEN == yes ]]; then "$INSTALL_DIR/scripts/harden.sh" --yes; fi

ok "настройка завершена"
if [[ -n ${AUTHOR_EMAILS:-} && $TUNNEL_MODE != quick && $TUNNEL_MODE != none ]]; then
  info "Закройте Studio Cloudflare Access: ./scripts/tunnel.sh access (или вручную — docs/admin/README.md §5)"
fi
info "Запуск: sudo ./scripts/start.sh"
