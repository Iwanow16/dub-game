#!/usr/bin/env bash
# Update (§21.4): backup → fetch new version → build → migrate → rolling restart (game-server
# last, draining its rooms) → smoke test. Any failure rolls back to the previous version and data.
#
#   sudo ./scripts/update.sh [--yes] [--ref v0.2.0]
#     --ref  git tag/branch to deploy (default: the newest v* tag)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REF=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -y | --yes) ASSUME_YES=1 ;;
    --ref) REF=$2; shift ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
  shift
done
require_root
need git docker
load_env
cd "$INSTALL_DIR"
[[ -d .git ]] || die "$INSTALL_DIR не git-репозиторий — установите через install.sh --repo"

step "Бэкап перед обновлением"
"$INSTALL_DIR/scripts/backup.sh" --quiet
backup=$(find "$INSTALL_DIR/backups" -maxdepth 1 -name 'dubroom-*' -type f -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
ok "бэкап: $backup"

prev_ref=$(git rev-parse HEAD)
prev_version=${DUBROOM_VERSION:-local}
git fetch --tags -q origin
if [[ -z $REF ]]; then REF=$(git tag -l 'v*' --sort=-v:refname | head -1); fi
[[ -n $REF ]] || die "не найдено ни одного тега v* — укажите --ref"
new_version=${REF#v}
if [[ $(git rev-parse "$REF^{commit}") == "$prev_ref" && $new_version == "$prev_version" ]]; then
  ok "уже на версии $REF"
  exit 0
fi
confirm "Обновить ${prev_version} → ${new_version}?" || die "отменено"

rollback() {
  err "обновление не удалось — откат к ${prev_version}"
  git checkout -q "$prev_ref"
  env_set "$ENV_FILE" DUBROOM_VERSION "$prev_version"
  load_env
  if [[ -n ${backup:-} ]]; then
    ASSUME_YES=1 "$INSTALL_DIR/scripts/restore.sh" "$backup" --yes ${BACKUP_AGE_IDENTITY:+--identity "$BACKUP_AGE_IDENTITY"} || true
  else
    compose up -d --remove-orphans
  fi
  notify "обновление до ${new_version} не удалось, выполнен откат к ${prev_version}"
  exit 1
}
trap rollback ERR

step "Сборка ${REF}"
git checkout -q "$REF"
env_set "$ENV_FILE" DUBROOM_VERSION "$new_version"
load_env
compose build

step "Перезапуск"
# api applies database migrations on start; worker and proxy follow
compose up -d --no-deps api media-worker
compose up -d --no-deps caddy
for _ in $(seq 1 60); do
  [[ $(compose ps api --format '{{.Health}}') == healthy ]] && break
  sleep 2
done
[[ $(compose ps api --format '{{.Health}}') == healthy ]] || false
# game-server last: SIGTERM lets running rounds finish (DRAIN_SECONDS)
compose up -d --no-deps game-server
compose up -d --remove-orphans

step "Смоук-тест"
for _ in $(seq 1 60); do
  compose exec -T caddy wget -q -O /dev/null http://localhost:8080/api/health 2>/dev/null && break
  sleep 2
done
compose exec -T caddy wget -q -O /dev/null http://localhost:8080/api/health
compose exec -T caddy wget -q -O /dev/null http://localhost:8080/api/game/health
compose exec -T caddy wget -q -O - http://localhost:8080/api/catalog | grep -q '"clips"'
compose exec -T caddy wget -q -O - --post-data '' http://localhost:8080/api/rooms | grep -q '"code"'
trap - ERR
ok "обновлено до ${new_version}"
