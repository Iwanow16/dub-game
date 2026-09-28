#!/usr/bin/env bash
# Backup (§21.4, §22.11): consistent SQLite snapshot, published clips and .env in one archive,
# encrypted with age when BACKUP_AGE_RECIPIENT is set; rotation 7 daily + 4 weekly; optional copy
# to external S3 (BACKUP_S3_URL, via rclone or aws cli). Player dubs are not backed up (24 h TTL).
#
#   sudo ./scripts/backup.sh [--with-uploads] [--quiet]
#     --with-uploads  also include Studio sources of unfinished drafts (can be large)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

UPLOADS=0
QUIET=0
for a in "$@"; do
  case $a in
    --with-uploads) UPLOADS=1 ;;
    --quiet) QUIET=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done
load_env
need tar
DEST="$INSTALL_DIR/backups"
mkdir -p "$DEST"
chmod 700 "$DEST"
stamp=$(date -u +%Y%m%d-%H%M%S)
kind=daily
[[ $(date -u +%u) == 7 ]] && kind=weekly
work=$(mktemp -d "$DEST/.tmp-XXXXXX")
trap 'rm -rf "$work"' EXIT
umask 077

db="${DATA_DIR}/db/dubroom.sqlite"
if [[ -f $db ]]; then
  if have sqlite3; then
    sqlite3 "$db" ".backup '$work/dubroom.sqlite'"
  else
    # online snapshot through the running API container (node:sqlite, VACUUM INTO)
    compose exec -T api node -e "new (require('node:sqlite').DatabaseSync)('/data/db/dubroom.sqlite').exec(\"VACUUM INTO '/data/db/.backup.sqlite'\")"
    mv "${DATA_DIR}/db/.backup.sqlite" "$work/dubroom.sqlite"
  fi
fi
cp "$ENV_FILE" "$work/env"
items=(-C "$work" .)
[[ -d ${DATA_DIR}/clips ]] && items+=(-C "$DATA_DIR" clips)
[[ -f ${DATA_DIR}/public/catalog.json ]] && items+=(-C "$DATA_DIR" public/catalog.json)
[[ $UPLOADS == 1 && -d ${DATA_DIR}/uploads ]] && items+=(-C "$DATA_DIR" uploads)

name="dubroom-${kind}-${stamp}.tar.gz"
tar -czf "$DEST/$name" "${items[@]}"
if [[ -n ${BACKUP_AGE_RECIPIENT:-} ]]; then
  need age
  age -r "$BACKUP_AGE_RECIPIENT" -o "$DEST/$name.age" "$DEST/$name"
  rm -f "$DEST/$name"
  name="$name.age"
else
  warn "BACKUP_AGE_RECIPIENT не задан — архив не зашифрован (права 600). См. docs/admin/README.md §10"
fi
[[ $QUIET == 1 ]] || ok "бэкап: $DEST/$name ($(du -h "$DEST/$name" | cut -f1))"

# rotation
prune() {
  local pattern=$1 keep=$2
  find "$DEST" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' | sort -rn | tail -n +"$((keep + 1))" | cut -d' ' -f2- | xargs -r rm -f
}
prune 'dubroom-daily-*' "${BACKUP_KEEP_DAILY:-7}"
prune 'dubroom-weekly-*' "${BACKUP_KEEP_WEEKLY:-4}"

if [[ -n ${BACKUP_S3_URL:-} ]]; then
  if have rclone; then
    rclone copy "$DEST/$name" "$BACKUP_S3_URL" && ok "копия отправлена в $BACKUP_S3_URL"
  elif have aws; then
    aws s3 cp --only-show-errors "$DEST/$name" "${BACKUP_S3_URL%/}/$name" && ok "копия отправлена в $BACKUP_S3_URL"
  else
    warn "BACKUP_S3_URL задан, но нет rclone или aws cli"
  fi
fi
