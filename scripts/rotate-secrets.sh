#!/usr/bin/env bash
# Secret rotation (§22.8). Planned every 90 days and immediately on suspected leak.
#
#   sudo ./scripts/rotate-secrets.sh [--all] [--token-key] [--studio-key] [--tunnel TOKEN] [--yes]
#     --token-key   new signing key; the old one stays valid for 24 h so players aren't kicked out
#                   (run again after 24 h — or from cron — to drop expired keys)
#     --studio-key  new Clip Studio key (tell your authors)
#     --tunnel      apply a new tunnel token (after "Refresh token" in the Cloudflare dashboard)
#     --all         token key + studio key (+ tunnel if a token is given)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

TOKEN_KEY=0
STUDIO=0
TUNNEL=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --all) TOKEN_KEY=1; STUDIO=1 ;;
    --token-key) TOKEN_KEY=1 ;;
    --studio-key) STUDIO=1 ;;
    --tunnel) TUNNEL=$2; shift ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
  shift
done
require_root
load_env
now=$(date -u +%s)
changed=()

# drop keys whose 24 h grace period is over
if [[ -n ${TOKEN_KEY_PREVIOUS_UNTIL:-} && $now -ge ${TOKEN_KEY_PREVIOUS_UNTIL} ]]; then
  env_set "$ENV_FILE" TOKEN_SIGNING_KEY "${TOKEN_SIGNING_KEY%%,*}"
  env_set "$ENV_FILE" TOKEN_KEY_PREVIOUS_UNTIL ""
  changed+=("старый ключ подписи удалён")
  load_env
fi

if [[ $TOKEN_KEY == 1 ]]; then
  new=$(random_secret 64)
  # first key signs, all keys verify: old tokens stay valid during the grace period
  env_set "$ENV_FILE" TOKEN_SIGNING_KEY "${new},${TOKEN_SIGNING_KEY%%,*}"
  env_set "$ENV_FILE" TOKEN_KEY_PREVIOUS_UNTIL "$((now + 24 * 3600))"
  changed+=("ключ подписи токенов (старый действует ещё 24 ч)")
fi
if [[ $STUDIO == 1 ]]; then
  key=$(random_secret 24)
  env_set "$ENV_FILE" STUDIO_KEY "$key"
  changed+=("ключ Clip Studio: $key")
fi
if [[ -n $TUNNEL ]]; then
  env_set "$ENV_FILE" TUNNEL_TOKEN "$(clean_tunnel_token "$TUNNEL")"
  changed+=("токен туннеля")
fi

if ((${#changed[@]} == 0)); then
  ok "нечего менять (см. --help)"
  exit 0
fi
[[ $TOKEN_KEY == 1 || $STUDIO == 1 || -n $TUNNEL ]] && env_set "$ENV_FILE" SECRETS_ROTATED_AT "$(date -u +%F)"
compose up -d --force-recreate api game-server
[[ -n $TUNNEL ]] && compose up -d --force-recreate cloudflared
for c in "${changed[@]}"; do ok "$c"; done
