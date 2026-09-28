#!/usr/bin/env bash
# Service logs (§21.4):  ./scripts/logs.sh [api|game-server|media-worker|caddy|cloudflared] [-f] [--since 1h]
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
case ${1:-} in
  -h | --help) sed -n '2p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
need docker
compose logs --tail 200 "$@"
