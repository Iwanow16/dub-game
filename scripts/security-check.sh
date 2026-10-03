#!/usr/bin/env bash
# Security audit (§22.12 checklist). Prints PASS/WARN/FAIL per item; exits 1 on any FAIL.
# Optional tools are used when installed: trivy, lynis, docker-bench-security, gitleaks, nmap.
#
#   sudo ./scripts/security-check.sh [--notify] [--external HOST]
#     --notify    send the summary via Telegram/e-mail (weekly cron)
#     --external  also scan HOST with nmap from this machine (better: from another machine)
# `check && pass "…" || fail "…"` is intended: pass() only prints and cannot fail.
# shellcheck disable=SC2015
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

NOTIFY=0
EXTERNAL=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --notify) NOTIFY=1 ;;
    --external) EXTERNAL=$2; shift ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
  shift
done
require_root
[[ -f $ENV_FILE ]] && load_env

fails=0
warns=0
pass() { printf '%s\n' "${C_GREEN}PASS${C_RESET} $*"; }
warnx() {
  printf '%s\n' "${C_YELLOW}WARN${C_RESET} $*"
  warns=$((warns + 1))
}
fail() {
  printf '%s\n' "${C_RED}FAIL${C_RESET} $*"
  fails=$((fails + 1))
}

step "Сеть"
if have ss; then
  listening=$(ss -Htuln | awk '{print $5}' | grep -vE '^(127\.|\[::1\]|\[?::ffff:127\.)' | grep -vE ':(68|546|323)$' | sort -u || true)
  ssh_open=0
  ufw status 2>/dev/null | grep -qE '^22/tcp' && ssh_open=1
  extra=$(grep -vE ':22$' <<<"$listening" || true)
  if [[ -z $extra ]]; then pass "нет открытых портов наружу$([[ $ssh_open == 1 ]] && echo ' (кроме SSH)')"; else fail "слушают наружу: $(tr '\n' ' ' <<<"$extra")"; fi
else
  warnx "нет утилиты ss (iproute2) — открытые порты не проверены"
fi
if ufw status 2>/dev/null | grep -q 'Status: active' && ufw status verbose | grep -q 'deny (incoming)'; then pass "ufw активен, входящие — deny"; else fail "ufw не активен или входящие не запрещены"; fi
if [[ -f $INSTALL_DIR/infra/docker-compose.yml ]] && compose config --format json 2>/dev/null | jq -e '[.services[] | .ports // [] | .[] | select((.host_ip // "") != "127.0.0.1")] | length == 0' >/dev/null 2>&1; then
  pass "в compose нет публичных ports:"
else
  fail "compose публикует порт не на 127.0.0.1"
fi
if [[ -n $EXTERNAL ]] && have nmap; then
  open=$(nmap -Pn --top-ports 1000 "$EXTERNAL" 2>/dev/null | awk '/open/ {print $1}' | grep -v '^22/' || true)
  if [[ -z $open ]]; then pass "nmap $EXTERNAL: открытых портов нет"; else fail "nmap $EXTERNAL: открыты $open"; fi
fi

step "SSH"
if have sshd; then
  cfg=$(sshd -T 2>/dev/null || true)
  grep -qx 'passwordauthentication no' <<<"$cfg" && pass "PasswordAuthentication no" || fail "вход по паролю разрешён"
  grep -qx 'permitrootlogin no' <<<"$cfg" && pass "PermitRootLogin no" || fail "root может входить по SSH"
  grep -q '^allowgroups ssh-admins' <<<"$cfg" && pass "AllowGroups ssh-admins" || warnx "AllowGroups не ограничен"
fi
systemctl is-active fail2ban >/dev/null 2>&1 && pass "fail2ban работает" || warnx "fail2ban не запущен"

step "Обновления"
if systemctl is-enabled unattended-upgrades >/dev/null 2>&1; then pass "unattended-upgrades включён"; else fail "автообновления безопасности выключены"; fi
if have apt-get; then
  pending=$(apt-get -s upgrade 2>/dev/null | grep -ci '^Inst.*securi' || true)
  if ((pending == 0)); then pass "нет ожидающих обновлений безопасности"; else warnx "ожидают обновления безопасности: $pending"; fi
fi
[[ -f /var/run/reboot-required ]] && warnx "нужна перезагрузка (ядро/библиотеки)"

step "Контейнеры"
if docker info >/dev/null 2>&1; then
  mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=dubroom")
  if ((${#ids[@]} == 0)); then warnx "контейнеры DubRoom не запущены"; fi
  for id in "${ids[@]}"; do
    name=$(docker inspect -f '{{.Name}}' "$id" | tr -d /)
    read -r user ro caps secopt < <(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}' "$id")
    problems=()
    [[ -z $user || $user == 0* || $user == root* ]] && problems+=("root")
    [[ $ro != true ]] && problems+=("rootfs rw")
    [[ $caps != *ALL* ]] && problems+=("cap_drop != ALL")
    [[ $secopt != *no-new-privileges* ]] && problems+=("нет no-new-privileges")
    if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" | grep -q docker.sock; then problems+=("смонтирован docker.sock"); fi
    if ((${#problems[@]})); then fail "$name: ${problems[*]}"; else pass "$name: non-root, read-only, cap_drop ALL, no-new-privileges"; fi
  done
  if have trivy; then
    crit=$(trivy image -q --severity CRITICAL --format json "${DUBROOM_IMAGE:-dubroom/app}:${DUBROOM_VERSION:-local}" 2>/dev/null | jq '[.Results[]?.Vulnerabilities[]?] | length' || echo "?")
    [[ $crit == 0 ]] && pass "trivy: критичных уязвимостей нет" || fail "trivy: критичных уязвимостей: $crit"
  else
    warnx "trivy не установлен — сканирование образов пропущено"
  fi
  if [[ -x /opt/docker-bench-security/docker-bench-security.sh ]]; then
    w=$(cd /opt/docker-bench-security && ./docker-bench-security.sh -c container_images,container_runtime,docker_daemon_configuration 2>/dev/null | grep -c '\[WARN\]' || true)
    ((w == 0)) && pass "docker-bench: без WARN" || warnx "docker-bench: WARN: $w"
  fi
else
  warnx "Docker недоступен"
fi

step "Секреты и данные"
if [[ -f $ENV_FILE ]]; then
  perm=$(stat -c '%a' "$ENV_FILE")
  [[ $perm == 600 ]] && pass ".env права 600" || fail ".env права $perm (нужно 600)"
  if [[ -n ${SECRETS_ROTATED_AT:-} ]]; then
    age_d=$((($(date +%s) - $(date -d "$SECRETS_ROTATED_AT" +%s)) / 86400))
    ((age_d < 90)) && pass "секретам $age_d дн." || fail "секретам $age_d дн. — ./scripts/rotate-secrets.sh --all"
  else
    warnx "дата ротации секретов неизвестна"
  fi
fi
if [[ -d $INSTALL_DIR/.git ]] && git -C "$INSTALL_DIR" ls-files --error-unmatch .env >/dev/null 2>&1; then fail ".env под контролем git!"; fi
if have gitleaks && [[ -d $INSTALL_DIR/.git ]]; then
  gitleaks detect -s "$INSTALL_DIR" --no-banner -q >/dev/null 2>&1 && pass "gitleaks: секретов в git нет" || fail "gitleaks нашёл секреты"
fi
last=$(find "$INSTALL_DIR/backups" -maxdepth 1 -name 'dubroom-*' -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 || true)
if [[ -n $last ]] && (($(date +%s) - ${last%.*} < 86400)); then pass "бэкап моложе 24 ч"; else fail "нет бэкапа за последние 24 ч"; fi
if [[ -n ${BACKUP_AGE_RECIPIENT:-} ]]; then pass "бэкапы шифруются (age)"; else warnx "бэкапы не шифруются — задайте BACKUP_AGE_RECIPIENT"; fi

step "Cloudflare и веб"
if [[ ${TUNNEL_MODE:-} != quick && ${TUNNEL_MODE:-} != none ]]; then
  [[ -n ${CF_ACCESS_AUD:-} ]] && pass "Clip Studio за Cloudflare Access" || fail "Clip Studio не закрыт Cloudflare Access — ./scripts/tunnel.sh access"
fi
[[ ${TUNNEL_MODE:-} == quick ]] && refresh_quick_url 0
if [[ -n ${PUBLIC_URL:-} && ${PUBLIC_URL} == https://* ]]; then
  headers=$(curl -fsSI -m 10 "$PUBLIC_URL/" 2>/dev/null || true)
  if ! grep -qi '^content-security-policy:' <<<"$headers"; then
    # the public address did not answer (fresh quick tunnel, network): ask Caddy from inside
    inner=$(compose exec -T caddy wget -S -q -O /dev/null http://localhost:8080/ 2>&1 | sed 's/^ *//' || true)
    if grep -qi '^content-security-policy:' <<<"$inner"; then
      warnx "$PUBLIC_URL не отдал заголовки (туннель или сеть) — проверены заголовки Caddy изнутри"
      headers=$inner
    fi
  fi
  for h in content-security-policy strict-transport-security x-content-type-options referrer-policy permissions-policy; do
    grep -qi "^$h:" <<<"$headers" && pass "заголовок $h" || fail "нет заголовка $h"
  done
fi

if have lynis; then
  idx=$(lynis audit system --quick --no-colors 2>/dev/null | awk -F': ' '/Hardening index/ {print $2}' | grep -oE '[0-9]+' | head -1 || true)
  if [[ -n $idx ]]; then ((idx >= 75)) && pass "Lynis hardening index $idx" || warnx "Lynis hardening index $idx (< 75)"; fi
else
  warnx "lynis не установлен — индекс защищённости не посчитан"
fi

printf '\n'
summary="security-check: FAIL $fails, WARN $warns"
if ((fails > 0)); then err "$summary"; else ok "$summary"; fi
if [[ $NOTIFY == 1 ]]; then notify "$summary"; fi
if ((fails > 0)); then exit 1; fi
