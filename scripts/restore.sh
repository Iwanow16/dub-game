#!/usr/bin/env bash
# Restores a backup made by backup.sh (§21.4) — on the same or a fresh installation.
#
#   sudo ./scripts/restore.sh <archive> [--yes] [--with-env] [--identity key.txt]
#     --with-env   also restore .env (secrets); on a fresh machine this is what you want
#     --identity   age identity file for encrypted archives (.age)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ARCHIVE=""
WITH_ENV=0
IDENTITY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -y | --yes) ASSUME_YES=1 ;;
    --with-env) WITH_ENV=1 ;;
    --identity) IDENTITY=$2; shift ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "неизвестный флаг: $1" ;;
    *) ARCHIVE=$1 ;;
  esac
  shift
done
require_root
[[ -f $ARCHIVE ]] || die "укажите архив: restore.sh /opt/dubroom/backups/dubroom-….tar.gz[.age]"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball=$ARCHIVE
if [[ $ARCHIVE == *.age ]]; then
  need age
  [[ -n $IDENTITY ]] || die "архив зашифрован — укажите --identity <age-key.txt>"
  age -d -i "$IDENTITY" -o "$work/backup.tar.gz" "$ARCHIVE"
  tarball="$work/backup.tar.gz"
fi
mkdir -p "$work/x"
tar -xzf "$tarball" -C "$work/x"
[[ -f $work/x/dubroom.sqlite ]] || die "в архиве нет базы данных"

if [[ $WITH_ENV == 1 || ! -f $ENV_FILE ]]; then
  install -m 600 -o root -g root "$work/x/env" "$ENV_FILE"
  # the backup may come from a machine with a different install path
  restored_data=$(env_get "$ENV_FILE" DATA_DIR)
  if [[ $restored_data != "$INSTALL_DIR"/* ]]; then
    env_set "$ENV_FILE" DATA_DIR "$INSTALL_DIR/data"
    info "DATA_DIR: ${restored_data} → $INSTALL_DIR/data"
  fi
  ok ".env восстановлен"
fi
load_env
confirm "Заменить текущие данные в ${DATA_DIR} данными из бэкапа?" || die "отменено"

if [[ -f $INSTALL_DIR/infra/docker-compose.yml ]] && docker info >/dev/null 2>&1; then
  compose stop -t 30 >/dev/null 2>&1 || true
fi
mkdir -p "${DATA_DIR}/db" "${DATA_DIR}/public"
rm -f "${DATA_DIR}/db/dubroom.sqlite"*
cp "$work/x/dubroom.sqlite" "${DATA_DIR}/db/dubroom.sqlite"
if [[ -d $work/x/clips ]]; then
  rm -rf "${DATA_DIR}/clips"
  cp -a "$work/x/clips" "${DATA_DIR}/clips"
fi
[[ -f $work/x/public/catalog.json ]] && cp "$work/x/public/catalog.json" "${DATA_DIR}/public/"
[[ -d $work/x/uploads ]] && cp -a "$work/x/uploads" "${DATA_DIR}/"
chown -R 10001:10001 "$DATA_DIR"
ok "данные восстановлены"
"$(dirname "$0")/start.sh" --yes
