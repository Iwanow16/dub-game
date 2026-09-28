#!/usr/bin/env bash
# DubRoom installer (§21.4): checks the OS, installs Docker + Compose, cloudflared and tools,
# creates the service user and /opt/dubroom. Idempotent — safe to run again.
#
#   sudo ./scripts/install.sh [--yes] [--dir /opt/dubroom] [--repo URL] [--ref TAG|BRANCH]
#
#   --yes        non-interactive
#   --dir        install directory (default /opt/dubroom)
#   --repo/--ref where to get the code when not run from a checkout
#                (default https://github.com/Iwanow16/dub-game, ref main)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPO_URL=${REPO_URL:-https://github.com/Iwanow16/dub-game.git}
REF=${REF:-main}
while [[ $# -gt 0 ]]; do
  case $1 in
    -y | --yes) ASSUME_YES=1 ;;
    --dir) INSTALL_DIR=$2; shift ;;
    --repo) REPO_URL=$2; shift ;;
    --ref) REF=$2; shift ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
  shift
done

require_root

step "Проверка системы"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:24.04 | debian:12) ok "ОС: ${PRETTY_NAME}" ;;
  ubuntu:* | debian:*) warn "ОС ${PRETTY_NAME} не проверялась — поддерживаются Ubuntu 24.04 и Debian 12" ;;
  *) die "нужна Ubuntu 24.04 или Debian 12 (найдено: ${PRETTY_NAME})" ;;
esac
cpus=$(nproc)
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
((cpus >= 2)) || warn "CPU: ${cpus} (рекомендуется ≥ 2)"
((mem_mb >= 3500)) || warn "RAM: ${mem_mb} МБ (рекомендуется ≥ 4 ГБ)"
((disk_gb >= 20)) || warn "свободно на диске: ${disk_gb} ГБ (рекомендуется ≥ 40 ГБ)"
ok "ресурсы: ${cpus} CPU, ${mem_mb} МБ RAM, ${disk_gb} ГБ свободно"

step "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq openssl git ufw fail2ban unattended-upgrades \
  sqlite3 age cron >/dev/null
ok "утилиты установлены"

step "Docker"
if ! have docker || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
# daemon hardening (§22.5): no inter-container traffic by default, log limits, live restore
mkdir -p /etc/docker
daemon_json='{
  "live-restore": true,
  "icc": false,
  "no-new-privileges": true,
  "userland-proxy": false,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}'
if [[ ! -f /etc/docker/daemon.json ]] || ! diff -q <(echo "$daemon_json" | jq -S .) <(jq -S . /etc/docker/daemon.json) >/dev/null 2>&1; then
  echo "$daemon_json" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null
ok "$(docker --version), $(docker compose version --short)"

step "cloudflared"
if ! have cloudflared; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    >/etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared >/dev/null
fi
ok "$(cloudflared --version 2>&1 | head -1)"

step "Пользователь и каталоги"
if ! id dubroom >/dev/null 2>&1; then
  useradd --system --uid 10001 --user-group --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin dubroom
fi
getent group ssh-admins >/dev/null || groupadd ssh-admins
if [[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]]; then usermod -aG ssh-admins,docker "$SUDO_USER"; fi
mkdir -p "$INSTALL_DIR"

if [[ -f $DUBROOM_ROOT/infra/docker-compose.yml && $DUBROOM_ROOT != "$INSTALL_DIR" ]]; then
  # running from a checkout: copy it (without local data and secrets)
  tar -C "$DUBROOM_ROOT" --exclude=./node_modules --exclude='*/node_modules' --exclude=./data \
    --exclude=./.env --exclude=./.env.dev --exclude='*/dist' -cf - . | tar -C "$INSTALL_DIR" -xf -
  ok "файлы скопированы из $DUBROOM_ROOT"
elif [[ -d $INSTALL_DIR/.git ]]; then
  git -C "$INSTALL_DIR" fetch --tags -q origin && git -C "$INSTALL_DIR" checkout -q "$REF"
  ok "обновлён $INSTALL_DIR ($REF)"
elif [[ ! -f $INSTALL_DIR/infra/docker-compose.yml ]]; then
  git clone -q --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  ok "клонирован $REPO_URL ($REF)"
fi
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/backups"
chown -R 10001:10001 "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/backups"

ok "установка завершена"
info "Дальше: cd $INSTALL_DIR && sudo ./scripts/setup.sh"
