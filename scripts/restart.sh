#!/usr/bin/env bash
# stop.sh + start.sh (§21.4). Flags are passed to both where they apply.
#   sudo ./scripts/restart.sh [--yes] [--force] [--build]
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
stop_args=()
start_args=()
for a in "$@"; do
  case $a in
    -y | --yes) stop_args+=("$a"); start_args+=("$a") ;;
    --force) stop_args+=("$a") ;;
    --build) start_args+=("$a") ;;
    -h | --help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done
"$(dirname "$0")/stop.sh" "${stop_args[@]}"
"$(dirname "$0")/start.sh" "${start_args[@]}"
