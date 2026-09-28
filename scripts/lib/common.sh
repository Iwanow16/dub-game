#!/usr/bin/env bash
# Shared helpers for DubRoom scripts (§21.4). Source it; do not execute.
# shellcheck disable=SC2034

set -Eeuo pipefail

DUBROOM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/dubroom}"
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
  [[ ${EUID} -eq 0 ]] || die "запустите с sudo: sudo $0 $*"
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

compose() {
  docker compose --project-directory "${INSTALL_DIR}" -f "${INSTALL_DIR}/infra/docker-compose.yml" --env-file "${INSTALL_DIR}/.env" "$@"
}

# wait_http URL [timeout_s]
wait_http() {
  local url=$1 timeout=${2:-60} i
  for ((i = 0; i < timeout; i++)); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then return 0; fi
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
