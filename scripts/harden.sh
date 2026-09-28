#!/usr/bin/env bash
# Baseline server hardening (§22.2–22.5, §22.11). Idempotent; safe to re-run. Called by setup.sh.
#
#   sudo ./scripts/harden.sh [--yes] [--ssh-mode access|classic] [--strict-egress] [--dry-run]
#     --ssh-mode access   (default) SSH only through Cloudflare Access: port 22 closed in ufw
#     --ssh-mode classic  port 22 open, keys only, fail2ban
#     --strict-egress     outbound only DNS, NTP, HTTP(S), Cloudflare tunnel (7844), SMTP
#     --dry-run           show what would change
#
# Lock-out protection: sshd is only reconfigured if the invoking admin has a working key and is
# in the ssh-admins group, the new config passes `sshd -t`, and sshd is reloaded (not restarted),
# so the current session stays open. Keep it open until a new login works.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

SSH_MODE=access
STRICT=0
DRY=0
while [[ $# -gt 0 ]]; do
  case $1 in
    -y | --yes) ASSUME_YES=1 ;;
    --ssh-mode) SSH_MODE=$2; shift ;;
    --strict-egress) STRICT=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
  shift
done
[[ $SSH_MODE == access || $SSH_MODE == classic ]] || die "--ssh-mode access|classic"
require_root

run() {
  if [[ $DRY == 1 ]]; then info "[dry-run] $*"; else "$@"; fi
}
# write_file PATH MODE <<content — only rewrites when the content differs; returns 0 if changed
write_file() {
  local path=$1 mode=$2 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  if [[ $DRY == 1 ]]; then
    info "[dry-run] изменить $path"
    rm -f "$tmp"
    return 0
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

step "Автоматические обновления безопасности (§22.2)"
write_file /etc/apt/apt.conf.d/52dubroom-unattended 644 <<'EOF' || true
Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
        "origin=Ubuntu,archive=${distro_codename}-security,label=Ubuntu";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
write_file /etc/apt/apt.conf.d/20auto-upgrades 644 <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
run timedatectl set-timezone Europe/Moscow 2>/dev/null || true
run systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "unattended-upgrades: только security, перезагрузка в 03:30 МСК при необходимости"

step "Синхронизация времени"
run timedatectl set-ntp true 2>/dev/null || true
ok "NTP включён"

step "Параметры ядра"
if write_file /etc/sysctl.d/90-dubroom.conf 644 <<'EOF'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
EOF
then run sysctl --system >/dev/null; fi
ok "/etc/sysctl.d/90-dubroom.conf"

step "Лишние службы"
for s in avahi-daemon cups rpcbind; do
  if systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl is-enabled "$s" >/dev/null 2>&1; then
    run systemctl disable --now "$s" >/dev/null 2>&1 || true
    ok "отключено: $s"
  fi
done
# /tmp as tmpfs with noexec,nosuid,nodev
if write_file /etc/systemd/system/tmp.mount.d/90-dubroom.conf 644 <<'EOF'
[Mount]
Options=mode=1777,strictatime,nosuid,nodev,noexec,size=50%
EOF
then
  run systemctl daemon-reload
  warn "/tmp станет noexec после перезагрузки"
fi

step "SSH (режим: $SSH_MODE)"
admin=${SUDO_USER:-}
key_ok=0
if [[ -n $admin && $admin != root ]]; then
  home=$(getent passwd "$admin" | cut -d: -f6)
  if [[ -s $home/.ssh/authorized_keys ]] && grep -qE '^(ssh-ed25519|sk-ssh-ed25519|ecdsa-sha2|sk-ecdsa|ssh-rsa) ' "$home/.ssh/authorized_keys"; then
    key_ok=1
  fi
  getent group ssh-admins >/dev/null || run groupadd ssh-admins
  id -nG "$admin" | grep -qw ssh-admins || run usermod -aG ssh-admins "$admin"
fi
if [[ $key_ok != 1 ]]; then
  warn "у администратора (${admin:-root}) нет SSH-ключа в authorized_keys — sshd не меняю, чтобы не потерять доступ"
  warn "добавьте ключ Ed25519 и запустите harden.sh снова (docs/admin/security.md)"
else
  if write_file /etc/ssh/sshd_config.d/90-dubroom.conf 644 <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowGroups ssh-admins
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
EOF
  then
    if [[ $DRY == 1 ]] || sshd -t; then
      run systemctl reload ssh 2>/dev/null || run systemctl reload sshd
      ok "sshd: только ключи, группа ssh-admins (текущая сессия не закрыта — проверьте новый вход!)"
    else
      rm -f /etc/ssh/sshd_config.d/90-dubroom.conf
      die "sshd -t не принял конфигурацию — изменения отменены"
    fi
  else
    ok "sshd уже настроен"
  fi
fi

step "Фаервол (ufw)"
need ufw
run ufw --force default deny incoming >/dev/null
run ufw --force default allow outgoing >/dev/null
if [[ $SSH_MODE == classic ]]; then
  run ufw limit 22/tcp comment 'ssh' >/dev/null
else
  # SSH через Cloudflare Access: cloudflared ходит к sshd локально, снаружи порт закрыт
  run ufw delete limit 22/tcp >/dev/null 2>&1 || true
  run ufw delete allow 22/tcp >/dev/null 2>&1 || true
fi
if [[ $STRICT == 1 ]]; then
  run ufw --force default deny outgoing >/dev/null
  for rule in "53" "123/udp" "80/tcp" "443/tcp" "7844" "587/tcp"; do run ufw allow out "$rule" >/dev/null; done
  ok "исходящие: DNS, NTP, HTTP(S), 7844 (туннель), SMTP"
fi
run ufw --force enable >/dev/null
ok "ufw: входящие запрещены${SSH_MODE/access/ (SSH только через Access)}"

# Docker publishes ports around ufw; DOCKER-USER drops new inbound connections to containers
# from outside interfaces (§22.4)
if have iptables && iptables -L DOCKER-USER >/dev/null 2>&1; then
  ext=$(ip route show default | awk '{print $5; exit}')
  if [[ -n $ext ]] && ! iptables -C DOCKER-USER -i "$ext" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
    run iptables -I DOCKER-USER -i "$ext" -m conntrack --ctstate NEW -j DROP
    ok "DOCKER-USER: входящие к контейнерам с $ext запрещены"
  fi
  # persist across reboots
  write_file /etc/systemd/system/dubroom-docker-user.service 644 <<EOF || true
[Unit]
Description=DubRoom: block inbound traffic to containers from ${ext}
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -i ${ext} -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER -i ${ext} -m conntrack --ctstate NEW -j DROP'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  run systemctl enable dubroom-docker-user.service >/dev/null 2>&1 || true
fi

step "fail2ban"
if write_file /etc/fail2ban/jail.d/dubroom.conf 644 <<'EOF'
[sshd]
enabled = true
maxretry = 3
findtime = 10m
bantime = 1h

[recidive]
enabled = true
bantime = 24h
findtime = 1d
maxretry = 3
EOF
then run systemctl restart fail2ban 2>/dev/null || true; fi
run systemctl enable fail2ban >/dev/null 2>&1 || true
ok "fail2ban: sshd 3 попытки → бан 1 ч, повторно → 24 ч"

step "Аудит (auditd)"
if ! have auditctl; then run apt-get install -y -qq auditd >/dev/null || warn "auditd не установлен"; fi
if write_file /etc/audit/rules.d/90-dubroom.rules 640 <<EOF
-w /etc/ -p wa -k etc-changes
-w ${INSTALL_DIR}/.env -p rwa -k dubroom-secrets
-w /usr/bin/sudo -p x -k sudo
-w /etc/sudoers -p wa -k sudoers
EOF
then run augenrules --load >/dev/null 2>&1 || true; fi
ok "auditd: /etc, .env, sudo"

step "Права на файлы сервиса"
[[ -f $ENV_FILE ]] && run chmod 600 "$ENV_FILE" && run chown root:root "$ENV_FILE"
[[ -d $INSTALL_DIR/backups ]] && run chmod 700 "$INSTALL_DIR/backups"
ok ".env 600, backups 700"

ok "harden.sh завершён. Проверка: sudo ./scripts/security-check.sh"
