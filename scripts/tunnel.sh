#!/usr/bin/env bash
# Cloudflare Tunnel management (§21.3, §21.4).
#
#   ./scripts/tunnel.sh info                 tunnel mode, connector status, public URL
#   ./scripts/tunnel.sh quick                switch to a quick tunnel (*.trycloudflare.com, demo only)
#   ./scripts/tunnel.sh token <TOKEN>        switch to / update mode A (token from the dashboard)
#   ./scripts/tunnel.sh rotate-token <TOKEN> same as token — use after "Refresh token" in the dashboard
#   ./scripts/tunnel.sh create               mode B: login, create tunnel "dubroom", DNS routes, config.yml
#   ./scripts/tunnel.sh route <hostname>     mode B: add a DNS route to the tunnel
#   ./scripts/tunnel.sh access               protect Clip Studio with Cloudflare Access (needs
#                                            CF_API_TOKEN, CF_ACCOUNT_ID, CF_ACCESS_TEAM_DOMAIN)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

cmd=${1:-info}
shift || true
for a in "$@"; do [[ $a == -y || $a == --yes ]] && ASSUME_YES=1; done
[[ $cmd == -h || $cmd == --help ]] && { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
load_env
CONF_DIR="$INSTALL_DIR/infra/cloudflared"


case $cmd in
  info)
    [[ ${TUNNEL_MODE:-} == quick ]] && refresh_quick_url 0
    info "режим: ${TUNNEL_MODE:-?}"
    info "адрес: ${PUBLIC_URL:-—}"
    compose ps cloudflared --format '{{.Name}} {{.State}} {{.Health}}' || true
    if [[ ${TUNNEL_MODE:-} == local ]] && have cloudflared; then cloudflared tunnel info dubroom || true; fi
    ;;

  quick)
    # Clip Studio is only reachable over SSH (ssh -L 8080:…) — under the studio.localhost name
    env_set "$ENV_FILE" PLAY_HOST localhost
    env_set "$ENV_FILE" STUDIO_HOST studio.localhost
    env_set "$ENV_FILE" TUNNEL_MODE quick
    env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 --url http://caddy:8080"
    env_set "$ENV_FILE" TUNNEL_REPLICAS 1
    env_set "$ENV_FILE" ALLOWED_ORIGINS ""
    env_set "$ENV_FILE" PUBLIC_URL ""
    env_set "$ENV_FILE" STUDIO_URL "http://studio.localhost:8080 (через ssh -L 8080:127.0.0.1:8080)"
    "$(dirname "$0")/start.sh" --yes
    ;;

  token | rotate-token)
    token=${1:-}
    [[ -n $token ]] || ask_secret token "новый TUNNEL_TOKEN"
    [[ -n $token ]] || die "токен не задан"
    token=$(clean_tunnel_token "$token")
    [[ $token =~ ^eyJ[A-Za-z0-9_=+/-]+$ ]] || die "это не похоже на токен туннеля (строка, начинающаяся с eyJ)"
    if [[ ${PLAY_HOST:-localhost} == localhost ]]; then
      # coming from quick/none: the stack needs real hostnames (Public Hostnames of the tunnel)
      [[ ${DOMAIN:-localhost} != localhost ]] && default_domain=$DOMAIN
      NEW_DOMAIN=${NEW_DOMAIN:-}
      ask NEW_DOMAIN "Домен в Cloudflare" "${default_domain:-}"
      [[ -n $NEW_DOMAIN && $NEW_DOMAIN != localhost ]] ||
        die "нужен домен: NEW_DOMAIN=example.com sudo -E ./scripts/tunnel.sh token <TOKEN>"
      env_set "$ENV_FILE" DOMAIN "$NEW_DOMAIN"
      env_set "$ENV_FILE" PLAY_HOST "play.${NEW_DOMAIN}"
      env_set "$ENV_FILE" STUDIO_HOST "studio.${NEW_DOMAIN}"
      load_env
    fi
    env_set "$ENV_FILE" TUNNEL_MODE token
    env_set "$ENV_FILE" TUNNEL_TOKEN "$token"
    env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 run"
    env_set "$ENV_FILE" TUNNEL_REPLICAS 2
    env_set "$ENV_FILE" PUBLIC_URL "https://${PLAY_HOST}"
    env_set "$ENV_FILE" STUDIO_URL "https://${STUDIO_HOST}"
    env_set "$ENV_FILE" ALLOWED_ORIGINS "https://${PLAY_HOST}"
    ok "режим token: ${PLAY_HOST}, ${STUDIO_HOST} — в панели туннеля оба Public Hostname → HTTP caddy:8080"
    # caddy (Studio hostname, no loopback port) and cloudflared change: start.sh applies it all
    "$(dirname "$0")/start.sh" --yes
    [[ -n ${CF_ACCESS_AUD:-} ]] || info "Закройте Studio Cloudflare Access: ./scripts/tunnel.sh access"
    ;;

  create)
    need cloudflared
    [[ -f $HOME/.cloudflared/cert.pem ]] || cloudflared tunnel login
    if ! cloudflared tunnel info dubroom >/dev/null 2>&1; then cloudflared tunnel create dubroom; fi
    id=$(cloudflared tunnel list -o json | jq -r '.[] | select(.name=="dubroom") | .id')
    [[ -n $id ]] || die "туннель dubroom не найден"
    install -d -m 750 "$CONF_DIR"
    install -m 640 "$HOME/.cloudflared/$id.json" "$CONF_DIR/dubroom.json"
    chown 65532:65532 "$CONF_DIR/dubroom.json"
    cat >"$CONF_DIR/config.yml" <<YML
tunnel: $id
credentials-file: /etc/cloudflared/dubroom.json
ingress:
  - hostname: ${PLAY_HOST}
    service: http://caddy:8080
  - hostname: ${STUDIO_HOST}
    service: http://caddy:8080
  - service: http_status:404
YML
    cloudflared tunnel route dns dubroom "$PLAY_HOST" || true
    cloudflared tunnel route dns dubroom "$STUDIO_HOST" || true
    ok "туннель dubroom ($id): ${PLAY_HOST}, ${STUDIO_HOST}"
    ;;

  route)
    need cloudflared
    host=${1:-}
    [[ -n $host ]] || die "укажите хостнейм"
    cloudflared tunnel route dns dubroom "$host"
    ok "маршрут $host → dubroom"
    ;;

  access)
    need curl jq
    ask CF_ACCOUNT_ID "Cloudflare Account ID"
    ask_secret CF_API_TOKEN "API-токен с правом Access: Apps and Policies Edit"
    ask CF_ACCESS_TEAM_DOMAIN "Team domain (например, myteam.cloudflareaccess.com)"
    ask AUTHOR_EMAILS "Email-ы авторов через запятую" "${AUTHOR_EMAILS:-}"
    [[ -n ${CF_ACCOUNT_ID:-} && -n ${CF_API_TOKEN:-} && -n ${AUTHOR_EMAILS:-} ]] || die "нужны CF_ACCOUNT_ID, CF_API_TOKEN и AUTHOR_EMAILS"
    include=$(jq -cn --arg e "$AUTHOR_EMAILS" '$e | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | map({email: {email: .}})')
    body=$(jq -cn --arg host "$STUDIO_HOST" --argjson inc "$include" '{
      name: "DubRoom Clip Studio", domain: $host, type: "self_hosted", session_duration: "12h",
      app_launcher_visible: false,
      policies: [{ name: "DubRoom authors", decision: "allow", include: $inc }]
    }')
    resp=$(curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" --data "$body") ||
      die "API Cloudflare вернул ошибку — настройте Access вручную (docs/admin/README.md §5)"
    aud=$(jq -r '.result.aud // empty' <<<"$resp")
    [[ -n $aud ]] || die "не удалось получить AUD: $(jq -c '.errors' <<<"$resp")"
    env_set "$ENV_FILE" CF_ACCESS_AUD "$aud"
    env_set "$ENV_FILE" CF_ACCESS_TEAM_DOMAIN "$CF_ACCESS_TEAM_DOMAIN"
    env_set "$ENV_FILE" AUTHOR_EMAILS "$AUTHOR_EMAILS"
    ok "Access-приложение для ${STUDIO_HOST} создано; API проверяет Cf-Access-Jwt-Assertion"
    compose up -d api
    ;;

  *) die "неизвестная команда: $cmd (см. --help)" ;;
esac
