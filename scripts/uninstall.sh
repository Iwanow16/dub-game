#!/usr/bin/env bash
# Removes DubRoom (§21.4): containers, images, systemd unit and cron jobs.
# Data (clips, database, backups, .env) is kept unless --purge is given and confirmed.
#
#   sudo ./scripts/uninstall.sh [--purge] [--yes]
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PURGE=0
for a in "$@"; do
  case $a in
    --purge) PURGE=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done
require_root
confirm "Удалить DubRoom с этого сервера?" || die "отменено"

if [[ -f $ENV_FILE ]] && docker info >/dev/null 2>&1; then
  compose down --rmi local --remove-orphans || true
fi
if [[ -f /etc/systemd/system/dubroom.service ]]; then
  systemctl disable --now dubroom.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/dubroom.service
  systemctl daemon-reload
fi
rm -f /etc/cron.d/dubroom
ok "сервис, образы, автозапуск и расписание удалены"

if [[ $PURGE == 1 ]]; then
  warn "будут удалены ВСЕ данные: $INSTALL_DIR (клипы, база, бэкапы, секреты)"
  ASSUME_YES=0
  if confirm "Точно удалить данные без возможности восстановления?"; then
    rm -rf "$INSTALL_DIR"
    ok "данные удалены"
  else
    info "данные сохранены в $INSTALL_DIR"
  fi
else
  info "данные сохранены в $INSTALL_DIR (удалить: --purge)"
fi
