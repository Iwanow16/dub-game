#!/usr/bin/env bash
# Tests for scripts/lib/common.sh: bash scripts/tests/common.test.sh
set -Eeuo pipefail
INSTALL_DIR=$(mktemp -d)
trap 'rm -rf "$INSTALL_DIR"' EXIT
export INSTALL_DIR
# shellcheck source=scripts/lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
trap 'rm -rf "$INSTALL_DIR"' EXIT

fails=0
check() {
  if [[ $2 == "$3" ]]; then ok "$1"; else
    err "$1: ожидалось «$3», получено «$2»"
    fails=$((fails + 1))
  fi
}

# .env as setup.sh writes it: values with spaces are not quoted (docker compose env file)
env_set "$ENV_FILE" TUNNEL_TOKEN "eyJhIjoiMSJ9"
env_set "$ENV_FILE" TUNNEL_COMMAND "tunnel --no-autoupdate --metrics 0.0.0.0:2000 run"
env_set "$ENV_FILE" AUTHOR_EMAILS "a@x.ru,b@y.ru"
printf '# comment\n\nQUOTED="a b"\nCRLF=v\r\nEQ=a=b\n' >>"$ENV_FILE"
load_env
check "значение с пробелами" "$TUNNEL_COMMAND" "tunnel --no-autoupdate --metrics 0.0.0.0:2000 run"
check "запятые" "$AUTHOR_EMAILS" "a@x.ru,b@y.ru"
check "кавычки снимаются" "$QUOTED" "a b"
check "CRLF" "$CRLF" "v"
check "знак = в значении" "$EQ" "a=b"
check "env_get" "$(env_get "$ENV_FILE" TUNNEL_COMMAND)" "tunnel --no-autoupdate --metrics 0.0.0.0:2000 run"

tok="eyJhIjoiYWJjIiwidCI6IjEyMyIsInMiOiJ4eXoifQ=="
check "токен как есть" "$(clean_tunnel_token "$tok")" "$tok"
check "команда service install" "$(clean_tunnel_token "sudo cloudflared service install $tok")" "$tok"
check "команда run --token" "$(clean_tunnel_token "cloudflared tunnel --no-autoupdate run --token $tok")" "$tok"

((fails == 0)) || die "провалено: $fails"
