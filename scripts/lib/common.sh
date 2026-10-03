#!/usr/bin/env bash
# Shared helpers for DubRoom scripts (§21.4). Source it; do not execute.
# shellcheck disable=SC2034

set -Eeuo pipefail

DUBROOM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# scripts run from an installation (or a checkout with its own .env) operate on that directory
if [[ -z ${INSTALL_DIR:-} && -f $DUBROOM_ROOT/.env ]]; then INSTALL_DIR=$DUBROOM_ROOT; fi
INSTALL_DIR="${INSTALL_DIR:-/opt/dubroom}"
ENV_FILE="${INSTALL_DIR}/.env"
ASSUME_YES="${ASSUME_YES:-0}"

if [[ -t 1 ]]; then
  C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BOLD=$'\e[1m' C_RESET=$'\e[0m'
else
  C_RED="" C_GREEN="" C_YELLOW="" C_BOLD="" C_RESET=""
fi

info() { printf '%s\n' "  $*"; }
ok() { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}⚠${C_RESET} $*" >&2; }
err() { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
die() {
  err "$*"
  exit 1
}
step() { printf '\n%s\n' "${C_BOLD}▸ $*${C_RESET}"; }

on_error() {
  local code=$? line=${1:-?}
  err "ошибка в строке ${line} (код ${code})"
  exit "$code"
}
trap 'on_error $LINENO' ERR

require_root() {
  [[ ${EUID} -eq 0 ]] || die "запустите с sudo: sudo $0"
}

have() { command -v "$1" >/dev/null 2>&1; }

need() {
  local c
  for c in "$@"; do have "$c" || die "не найдено: $c"; done
}

# confirm "Вопрос?" → 0 if yes. Non-interactive (--yes) always answers yes.
confirm() {
  [[ ${ASSUME_YES} == 1 ]] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ ${answer,,} == y || ${answer,,} == yes || ${answer,,} == д || ${answer,,} == да ]]
}

# ask VAR "Question" [default] — keeps an existing env value in non-interactive mode
ask() {
  local var=$1 question=$2 default=${3:-} value
  value=${!var:-}
  if [[ -n ${value} ]]; then return 0; fi
  if [[ ${ASSUME_YES} == 1 ]]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  read -r -p "? ${question}${default:+ [$default]}: " value
  printf -v "$var" '%s' "${value:-$default}"
}

ask_secret() {
  local var=$1 question=$2 value
  value=${!var:-}
  if [[ -n ${value} ]]; then return 0; fi
  [[ ${ASSUME_YES} == 1 ]] && return 0
  read -r -s -p "? ${question}: " value
  printf '\n'
  printf -v "$var" '%s' "$value"
}

random_secret() {
  # URL-safe, no padding
  openssl rand -base64 "${1:-48}" | tr -d '\n=' | tr '+/' '-_'
}

# env_get FILE KEY
env_get() {
  local file=$1 key=$2
  [[ -f ${file} ]] || return 0
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

# env_set FILE KEY VALUE — idempotent upsert, keeps permissions
env_set() {
  local file=$1 key=$2 value=$3 tmp
  touch "$file"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# Loads .env into the environment (for scripts that need its values). The file is parsed, not
# sourced: it is a docker compose env file, where `KEY=a b c` is a plain value — bash would run
# `b` as a command (TUNNEL_COMMAND=tunnel --no-autoupdate … broke start.sh in 0.2.0).
load_env() {
  [[ -r $ENV_FILE ]] || die "нет $ENV_FILE — сначала запустите scripts/setup.sh"
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      warn "$ENV_FILE: пропущена непонятная строка «${line:0:30}…»"
      continue
    fi
    key=${BASH_REMATCH[2]} value=${BASH_REMATCH[3]}
    # one pair of surrounding quotes is stripped, as docker compose does
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    export "$key=$value"
  done <"$ENV_FILE"
}

# clean_tunnel_token VALUE — the token itself, also when the whole install command from the
# Cloudflare dashboard was pasted ("cloudflared service install eyJ…" / "… run --token eyJ…")
clean_tunnel_token() {
  local t
  t=$(grep -oE 'eyJ[A-Za-z0-9_=+/-]{20,}' <<<"$1" | head -n1 || true)
  printf '%s' "${t:-$1}"
}

# docker compose with the project's files; adds the tunnel profile and, for local-only or quick
# tunnel setups, the loopback port binding (infra/docker-compose.local.yml).
compose() {
  local mode files=(-f "${INSTALL_DIR}/infra/docker-compose.yml")
  mode=$(env_get "$ENV_FILE" TUNNEL_MODE)
  if [[ $mode == none || $mode == quick || $(env_get "$ENV_FILE" LOCAL_ACCESS) == 1 ]]; then
    files+=(-f "${INSTALL_DIR}/infra/docker-compose.local.yml")
  fi
  local profile=()
  [[ -n $mode && $mode != none ]] && profile=(--profile tunnel)
  docker compose --project-directory "${INSTALL_DIR}" "${files[@]}" --env-file "$ENV_FILE" "${profile[@]}" "$@"
}

# notify "text" — Telegram and/or e-mail if configured in .env (status.sh --notify, §22.11)
notify() {
  local text token chat mail
  text="[DubRoom $(hostname)] $1"
  token=$(env_get "$ENV_FILE" NOTIFY_TELEGRAM_TOKEN)
  chat=$(env_get "$ENV_FILE" NOTIFY_TELEGRAM_CHAT)
  mail=$(env_get "$ENV_FILE" NOTIFY_EMAIL)
  if [[ -n $token && -n $chat ]]; then
    curl -fsS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" >/dev/null || warn "telegram: не отправлено"
  fi
  if [[ -n $mail ]] && have mail; then
    printf '%s\n' "$text" | mail -s "DubRoom: $(hostname)" "$mail" || warn "почта: не отправлено"
  fi
}

# wait_http URL [timeout_s]
# SHA-256 of cloudflared release binaries for 32-bit ARM, per version (github.com/cloudflare/cloudflared)
declare -A CLOUDFLARED_SHA256_ARMHF=([2025.9.1]=f4d4829c83323e95b9b7bf733b904f8d039d9a01a58ef50d524414f2f1d02fe6)
declare -A CLOUDFLARED_SHA256_ARM=([2025.9.1]=ecef68497b742bfd09d64718b5fa94e16b086253d5024da60faf6ab72afe93c1)

# ensure_cloudflared_image — the official image has no 32-bit ARM variant ("no matching manifest
# for linux/arm/v7"); there, build dubroom/cloudflared from the release binary. The Docker
# server's arch decides: a Raspberry Pi with a 64-bit kernel and 32-bit OS reports aarch64 in
# uname but runs a 32-bit ("arm") Docker.
ensure_cloudflared_image() {
  local mode arch asset sha ver
  mode=$(env_get "$ENV_FILE" TUNNEL_MODE)
  [[ $mode == token || $mode == local || $mode == quick ]] || return 0
  arch=${DUBROOM_DOCKER_ARCH:-$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)}
  [[ $arch == arm ]] || return 0
  ver=$(env_get "$ENV_FILE" CLOUDFLARED_VERSION)
  ver=${ver:-2025.9.1}
  if [[ $(uname -m) == armv6* ]]; then
    asset=cloudflared-linux-arm
    sha=${CLOUDFLARED_SHA256_ARM[$ver]:-}
  else
    asset=cloudflared-linux-armhf
    sha=${CLOUDFLARED_SHA256_ARMHF[$ver]:-}
  fi
  sha=$(env_get "$ENV_FILE" CLOUDFLARED_SHA256 | grep . || printf '%s' "$sha")
  [[ -n $sha ]] || die "для cloudflared ${ver} (${asset}) нет контрольной суммы: укажите CLOUDFLARED_SHA256 в .env или CLOUDFLARED_VERSION=2025.9.1"
  [[ $(env_get "$ENV_FILE" CLOUDFLARED_IMAGE) == dubroom/cloudflared ]] || env_set "$ENV_FILE" CLOUDFLARED_IMAGE dubroom/cloudflared
  export CLOUDFLARED_IMAGE=dubroom/cloudflared
  docker image inspect "dubroom/cloudflared:${ver}" >/dev/null 2>&1 && return 0
  step "Образ cloudflared для 32-битного ARM (${asset} ${ver})"
  docker build --target cloudflared \
    --build-arg "CLOUDFLARED_VERSION=${ver}" --build-arg "CLOUDFLARED_ASSET=${asset}" \
    --build-arg "CLOUDFLARED_SHA256=${sha}" \
    -t "dubroom/cloudflared:${ver}" -f "${INSTALL_DIR}/infra/Dockerfile" "${INSTALL_DIR}"
  ok "dubroom/cloudflared:${ver}"
}

# quick_tunnel_url — address of the running quick tunnel, taken from the CURRENT run of the
# cloudflared container only: after a restart the old address is still in its log
quick_tunnel_url() {
  local id started
  id=$(compose ps -q cloudflared 2>/dev/null | head -n1 || true)
  [[ -n $id ]] || return 0
  started=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || true)
  docker logs ${started:+--since "$started"} "$id" 2>&1 |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n1 || true
}

# refresh_quick_url [wait_s] — waits for the quick tunnel address and stores it as PUBLIC_URL
refresh_quick_url() {
  local wait=${1:-60} waited=0 url=""
  while :; do
    url=$(quick_tunnel_url)
    [[ -n $url ]] || ((waited >= wait)) && break
    sleep 2
    waited=$((waited + 2))
  done
  if [[ -n $url && $url != "$(env_get "$ENV_FILE" PUBLIC_URL)" ]]; then env_set "$ENV_FILE" PUBLIC_URL "$url"; fi
  PUBLIC_URL=${url:-}
}

wait_http() {
  local url=$1 timeout=${2:-60} i
  for ((i = 0; i < timeout; i++)); do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

parse_common_flags() {
  local a
  for a in "$@"; do
    case $a in
      -y | --yes) ASSUME_YES=1 ;;
    esac
  done
}
