#!/usr/bin/env bash
# Health report (§21.4): containers, tunnel, database, disk, backups, version.
#   ./scripts/status.sh [--notify] [--quiet]
#     --notify  send a Telegram/e-mail alert when something is wrong (cron, §22.11)
#     --quiet   print only problems
# Exit code: 0 all good, 1 problems found.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

NOTIFY=0
QUIET=0
for a in "$@"; do
  case $a in
    --notify) NOTIFY=1 ;;
    --quiet) QUIET=1 ;;
    -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done
need docker
load_env

problems=()
good() { [[ $QUIET == 1 ]] || ok "$*"; }
bad() {
  problems+=("$*")
  err "$*"
}

[[ $QUIET == 1 ]] || step "Сервисы (версия ${DUBROOM_VERSION:-?})"
expected=(api game-server media-worker caddy)
[[ ${TUNNEL_MODE:-none} != none ]] && expected+=(cloudflared)
ps_out=$(compose ps --all --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)
for svc in "${expected[@]}"; do
  lines=$(grep "^${svc}|" <<<"$ps_out" || true)
  if [[ -z $lines ]]; then
    bad "$svc: не запущен"
    continue
  fi
  total=$(wc -l <<<"$lines")
  running=$(grep -c '|running|' <<<"$lines" || true)
  unhealthy=$(grep -cE '\|(unhealthy|starting)$' <<<"$lines" || true)
  if ((running < total)); then
    bad "$svc: работает $running из $total"
  elif ((unhealthy > 0)); then
    bad "$svc: healthcheck не проходит"
  else
    good "$svc ($running/$total)"
  fi
done

[[ $QUIET == 1 ]] || step "Доступность"
if [[ ${TUNNEL_MODE:-} == quick ]]; then
  # cloudflared restarted (crash, docker restart policy) → the quick tunnel has a new address
  old_url=${PUBLIC_URL:-}
  refresh_quick_url 0
  if [[ -n $PUBLIC_URL && $PUBLIC_URL != "$old_url" ]]; then
    warn "у быстрого туннеля новый адрес: $PUBLIC_URL (начнёт открываться через 1–2 минуты)"
    [[ $NOTIFY == 1 ]] && notify "новый адрес игры: $PUBLIC_URL"
    PUBLIC_URL="" # a fresh quick tunnel is not reachable yet: check it next time
  fi
fi
if [[ -n ${PUBLIC_URL:-} && ${PUBLIC_URL} == https://* ]]; then
  if curl -fsS -m 10 -o /dev/null "${PUBLIC_URL}/api/health" 2>/dev/null; then good "${PUBLIC_URL} отвечает"; else bad "${PUBLIC_URL} не отвечает (туннель, DNS или сервисы)"; fi
fi
if compose exec -T api wget -q -O /dev/null http://localhost:3000/api/health 2>/dev/null; then good "API"; else bad "API не отвечает внутри сети"; fi

[[ $QUIET == 1 ]] || step "Данные"
db="${DATA_DIR}/db/dubroom.sqlite"
if [[ -f $db ]]; then
  good "БД $(du -h "$db" | cut -f1)"
  if have sqlite3; then
    check=$(sqlite3 "file:${db}?mode=ro" 'PRAGMA quick_check;' 2>&1 || true)
    if [[ $check == ok ]]; then good "БД: целостность ok"; else bad "БД: quick_check → $check"; fi
  fi
else
  bad "нет базы $db"
fi
use=$(df --output=pcent "$DATA_DIR" | tail -1 | tr -dc '0-9')
if ((use > 80)); then bad "диск заполнен на ${use}%"; else good "диск: ${use}%"; fi
last_backup=$(find "$INSTALL_DIR/backups" -maxdepth 1 -name 'dubroom-*' -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 || true)
if [[ -z $last_backup ]]; then
  bad "бэкапов нет — ./scripts/backup.sh"
else
  age_h=$((($(date +%s) - ${last_backup%.*}) / 3600))
  if ((age_h > 26)); then bad "последний бэкап ${age_h} ч назад"; else good "последний бэкап ${age_h} ч назад"; fi
fi

if ((${#problems[@]})); then
  [[ $NOTIFY == 1 ]] && notify "проблемы: $(IFS='; '; echo "${problems[*]}")"
  exit 1
fi
[[ $QUIET == 1 ]] || ok "всё в порядке"
