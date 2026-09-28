# Безопасность сервера

Что настраивают `harden.sh` и проверяет `security-check.sh` (§22 плана). Прикладная безопасность игры — модерация, записи игроков, имена — описана в §14.

## Модель угроз (кратко)

| Что защищаем | От чего | Главная мера |
|---|---|---|
| Сервер | сканирование, подбор SSH, эксплойты | ни одного открытого входящего порта; SSH только по ключу или через Access |
| Clip Studio | посторонний доступ, вредные файлы | Cloudflare Access + ключ; обработка медиа без сети |
| Клипы, БД, секреты | утечка, порча, шифровальщики | изоляция контейнеров, права 600, зашифрованные бэкапы вне сервера |
| Доступность | DDoS, флуд | WAF и rate limiting Cloudflare + лимиты в приложении |
| Цепочка поставки | уязвимые зависимости | lockfile, Dependabot, gitleaks и сканирование образов |

## Что делает `harden.sh`

- **Обновления:** `unattended-upgrades` только из security-репозиториев, перезагрузка в 03:30 МСК при необходимости.
- **Ядро** (`/etc/sysctl.d/90-dubroom.conf`): rp_filter, запрет redirects и source routing, syncookies, `kptr_restrict`, `dmesg_restrict`, защита hard/symlinks.
- **Службы:** отключены avahi, cups, rpcbind; `/tmp` — `noexec,nosuid,nodev` после перезагрузки.
- **SSH** (`/etc/ssh/sshd_config.d/90-dubroom.conf`): только ключи, `PermitRootLogin no`, `AllowGroups ssh-admins`, `MaxAuthTries 3`, без X11/agent/TCP-forwarding. **Защита от блокировки себя:** настройки применяются, только если у текущего администратора есть ключ в `authorized_keys`; конфигурация проверяется `sshd -t`; sshd перечитывает настройки без обрыва текущей сессии. Не закрывайте её, пока не убедитесь, что новый вход работает.
- **Фаервол:** `ufw` — входящие запрещены; SSH снаружи открыт только в режиме `--ssh-mode classic`. `--strict-egress` оставляет исходящие DNS, NTP, HTTP(S), 7844 (туннель) и SMTP.
- **Docker и фаервол:** опубликованные порты контейнеров обходят `ufw`, поэтому в `docker-compose.yml` нет ни одного `ports:`, а цепочка `DOCKER-USER` отбрасывает новые входящие соединения к контейнерам с внешнего интерфейса (правило переживает перезагрузку).
- **fail2ban:** 3 неудачные попытки SSH — бан на 1 ч, повторно — на 24 ч.
- **auditd:** изменения в `/etc`, доступ к `.env`, вызовы `sudo`.

`install.sh` дополнительно настраивает демон Docker: `live-restore`, `icc: false`, `no-new-privileges`, ограничение логов.

## Контейнеры

Все сервисы (`infra/docker-compose.yml`): пользователь 10001 (не root), корневая ФС только для чтения, `cap_drop: ALL`, `no-new-privileges`, лимиты CPU/памяти, ротация логов. Docker-сокет не монтируется никуда.

| Сеть | Кто | Интернет |
|---|---|---|
| `edge` | cloudflared, caddy | только cloudflared (исходящий туннель) |
| `backend` (`internal`) | caddy, api, game-server | нет |
| — (`network_mode: none`) | media-worker | нет вообще: недоверенные видео обрабатываются без сети |

Файлы, загруженные в Studio, сначала проверяются `ffprobe` по белому списку (MP4/MOV/MKV; H.264/H.265/VP9/AV1/…; ≤ 10 мин; ≤ 4K), каждый вызов FFmpeg идёт с таймаутом, игрокам отдаются только перекодированные файлы.

## Секреты

- Все секреты генерирует `setup.sh` (`openssl rand`) в `/opt/dubroom/.env` (root, 600). `.env` в `.gitignore`, в CI — gitleaks.
- Логи API не содержат токенов, ключей и тикетов загрузки (redact).
- **Ротация** — `rotate-secrets.sh`: ключ подписи токенов меняется с 24-часовым периодом, когда действуют оба ключа (игроков не выкидывает); ключ Studio; токен туннеля (после *Refresh token* в панели). Раз в 90 дней и сразу при подозрении на утечку. `security-check.sh` предупредит, если секретам больше 90 дней.

## Cloudflare

- 2FA у всех участников аккаунта; API-токены — только с нужными правами и зоной.
- SSL/TLS: Always Use HTTPS, TLS ≥ 1.2, HSTS (Caddy отдаёт `Strict-Transport-Security`), DNSSEC.
- WAF: блок `/api/studio/*` на хостнейме игры, ограничение методов; rate limiting — см. [руководство](README.md#6-кеширование-https-и-защита-на-стороне-cloudflare).
- Access: Studio, Grafana (если есть), SSH — список e-mail, сессия 12 ч.
- Реальный IP игрока берётся из `CF-Connecting-IP` только от внутренних прокси (Caddy доверяет частным сетям, API — только за Caddy).

## Заголовки

Caddy добавляет ко всем ответам: `Content-Security-Policy` (скрипты только свои, без inline), `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (микрофон — только свой сайт), `Cross-Origin-Opener-Policy`, убирает `Server`. WebSocket проверяет `Origin` (`ALLOWED_ORIGINS`), сообщения ≤ 16 КБ, ≤ 20 в секунду, ≤ 3 соединений на игрока.

## Чек-лист (`security-check.sh`) {#checklist}

- [ ] Открытых портов нет (кроме SSH в классическом режиме); `--external HOST` дополнительно сканирует nmap
- [ ] Вход только по ключу, root запрещён
- [ ] ufw активен, входящие — deny; в compose нет публичных `ports:`
- [ ] Автообновления включены, критичных обновлений не ждём
- [ ] Контейнеры не от root, read-only, `cap_drop: ALL`, `no-new-privileges`
- [ ] Trivy: нет Critical (если установлен); docker-bench без WARN
- [ ] Lynis ≥ 75 (если установлен)
- [ ] `.env` 600, секретам < 90 дней, секретов нет в git
- [ ] Studio закрыта Access; заголовки безопасности на месте
- [ ] Бэкап моложе 24 ч и зашифрован

Установить дополнительные инструменты: `apt install lynis nmap`, [Trivy](https://aquasecurity.github.io/trivy/), [docker-bench-security](https://github.com/docker/docker-bench-security) в `/opt/docker-bench-security`.

## Инцидент {#incident}

1. **Изолировать:** `sudo ./scripts/stop.sh --maintenance` (сайт отвечает 503), при необходимости остановить туннель: `./scripts/logs.sh` → `docker compose … stop cloudflared` или отключить туннель в панели.
2. **Сохранить улики:** `journalctl`, `/var/log/audit/`, `./scripts/logs.sh --since 48h > incident.log`, снимок диска у провайдера.
3. **Сменить все секреты:** `sudo ./scripts/rotate-secrets.sh --all --tunnel <новый токен>`, ключи SSH администраторов, пароли Cloudflare.
4. **Восстановиться** из последнего чистого бэкапа на обновлённой системе (`restore.sh`), обновить образы (`update.sh`).
5. **Разбор:** запись в журнал инцидентов, исправление причины; при утечке персональных данных — уведомление пользователей в сроки, установленные законом.
