# Руководство администратора DubRoom

Как развернуть и сопровождать DubRoom на своём сервере — VPS, выделенном сервере или домашнем мини-ПК — **без белого IP и открытых портов**: в интернет сервис выходит через Cloudflare Tunnel (§21 плана).

Безопасность сервера подробно — в [security.md](security.md).

## 1. Что понадобится

| | Минимум | Рекомендуется |
|---|---|---|
| Сервер | 2 vCPU, 4 ГБ RAM, 40 ГБ SSD | 4 vCPU, 8 ГБ, 100 ГБ SSD |
| ОС | Ubuntu 24.04 LTS или Debian 12, минимальная установка | |
| Домен | подключённый к Cloudflare (тариф Free подходит) | |
| Аккаунт Cloudflare | с включённой 2FA | |

Для демо без домена подойдёт «быстрый туннель» (`*.trycloudflare.com`), см. §3.

## 2. Подключение домена к Cloudflare

1. Cloudflare → **Add a site** → введите домен → тариф Free.
2. У регистратора домена замените NS-серверы на выданные Cloudflare. Дождитесь статуса **Active** (обычно до часа).
3. **SSL/TLS** → режим *Full*; **Edge Certificates** → *Always Use HTTPS* — вкл., *Minimum TLS* — 1.2; **DNSSEC** — вкл.

## 3. Туннель

Выберите режим (§21.3):

| Режим | Когда | Что сделать |
|---|---|---|
| **A. Токен** (рекомендуется) | продакшн | Zero Trust → **Networks → Tunnels → Create a tunnel** → *Cloudflared* → имя `dubroom` → скопируйте токен из команды установки (строка после `--token`). На вкладке **Public Hostname** добавьте `play.<домен>` и `studio.<домен>` → сервис **HTTP**, `caddy:8080`. |
| **B. Локальный** | конфигурация в git | `setup.sh` сам вызовет `./scripts/tunnel.sh create`: вход в Cloudflare через браузер, создание туннеля, DNS-маршруты и `infra/cloudflared/config.yml`. |
| **C. Быстрый** | демо, тест с друзьями | ничего не нужно; адрес `https://….trycloudflare.com` выдаётся при каждом запуске. Clip Studio доступна только с сервера: `ssh -L 8080:127.0.0.1:8080 сервер` → http://studio.localhost:8080. |

Токен туннеля — секрет: он хранится только в `/opt/dubroom/.env`.

## 4. Установка

```bash
# 1. Зависимости и файлы (Docker, cloudflared, пользователь dubroom, /opt/dubroom)
git clone https://github.com/Iwanow16/dub-game.git && cd dub-game
sudo ./scripts/install.sh

# 2. Настройка (домен, режим туннеля, токен, e-mail авторов; секреты генерируются сами)
cd /opt/dubroom && sudo ./scripts/setup.sh
#   ? Режим туннеля: token
#   ? Домен в Cloudflare: example.com
#   ? TUNNEL_TOKEN: ********
#   ? Email-ы авторов Clip Studio: author1@…, author2@…
#   ✓ .env: /opt/dubroom/.env (права 600, секреты сгенерированы)
#   ✓ systemd: dubroom.service включён

# 3. Запуск
sudo ./scripts/start.sh
#   ✓ api (healthy) ✓ caddy (healthy) ✓ game-server (healthy) ✓ media-worker ✓ cloudflared
#   Игра:        https://play.example.com
#   Clip Studio: https://studio.example.com

# 4. Стартовые клипы
sudo ./scripts/seed-clips.sh content/starter-pack --approve
```

Без вопросов (для автоматизации): `DOMAIN=example.com TUNNEL_MODE=token TUNNEL_TOKEN=… sudo -E ./scripts/setup.sh --yes`.

Все скрипты понимают `--help`, работают повторно без вреда и возвращают ненулевой код при ошибке. Короткие алиасы — `make help`.

## 5. Cloudflare Access для Clip Studio

Studio — инструмент авторов, посторонним туда нельзя (§22.9).

**Автоматически:** создайте API-токен (My Profile → API Tokens → *Custom token*, права **Account → Access: Apps and Policies → Edit**) и выполните:

```bash
sudo ./scripts/tunnel.sh access
#   ? Cloudflare Account ID
#   ? API-токен
#   ? Team domain (myteam.cloudflareaccess.com)
#   ? Email-ы авторов
```

Скрипт создаст Access-приложение для `studio.<домен>` с входом по одноразовому коду на почту и сохранит его AUD в `.env`: API начнёт проверять подпись `Cf-Access-Jwt-Assertion`.

**Вручную:** Zero Trust → **Access → Applications → Add → Self-hosted**, домен `studio.<домен>`, сессия 12 ч, политика *Allow* → *Emails* — список авторов. Скопируйте *Application Audience (AUD) Tag* и team domain в `.env` (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`) → `sudo ./scripts/restart.sh`.

Добавить автора — допишите e-mail в политику. Кроме Access, Studio спрашивает **ключ** (`STUDIO_KEY` в `.env`) — передайте его авторам.

## 6. Кеширование, HTTPS и защита на стороне Cloudflare

**Rules → Cache Rules:**

| Правило | Условие | Действие |
|---|---|---|
| Медиа | URI path starts with `/media/clips/` | Eligible for cache, Edge TTL: *use origin* |
| Статика | URI path starts with `/assets/` | Eligible for cache |
| API и WebSocket | URI path starts with `/api/` or equals `/ws` | Bypass cache |

**Security → WAF → Custom rules:** блокировать `/api/studio/*` на хостнейме игры (Caddy тоже отвечает 404 — двойная защита). **Rate limiting:** `/api/rooms` — 10/мин на IP; `/api/guest` — 30/мин; `/api/dubs` — 20/мин. **Bots:** Bot Fight Mode — вкл.

## 7. Стартовые клипы

`seed-clips.sh` импортирует набор через обычный конвейер (Studio API → обработка → модерация). `--approve` сразу публикует — только для доверенных наборов. Повторный запуск пропускает уже опубликованные клипы.

Свои клипы готовят авторы в Clip Studio — см. [руководство автора](../user/author.md).

**Длинные клипы** ([ADR-0009](../adr/0009-long-clips-scenes-and-streaming.md)): длина ограничена `CLIP_MAX_MINUTES` в `.env` (по умолчанию 180), один дубль — `DUB_MAX_MB` (по умолчанию 64). Обработка часового эпизода занимает десятки минут и требует места: пакеты сцен добавляют примерно столько же, сколько сам клип. Если дисков мало — уменьшите `CLIP_MAX_MINUTES`.

## 8. Ежедневная работа

```bash
sudo ./scripts/status.sh             # контейнеры, доступность, БД, диск, бэкапы
sudo ./scripts/logs.sh api -f        # логи сервиса (api, game-server, media-worker, caddy, cloudflared)
sudo ./scripts/tunnel.sh info        # состояние туннеля
```

**Модерация:** новые клипы ждут в Studio → «Библиотека» → «На модерации». Жалобы игроков — Studio → «Жалобы»; по жалобе на права клип снимается кнопкой «В архив» в течение 24 ч (§14).

Cron (ставит `setup.sh`, файл `/etc/cron.d/dubroom`): бэкап в 04:10, `status.sh --notify` каждые 5 минут, `security-check.sh` по понедельникам. Для уведомлений задайте в `.env` `NOTIFY_TELEGRAM_TOKEN` и `NOTIFY_TELEGRAM_CHAT` (или `NOTIFY_EMAIL` + настроенный `mail`).

## 9. Обновление и откат

```bash
sudo ./scripts/update.sh              # до последнего тега v*
sudo ./scripts/update.sh --ref v0.2.0 # до конкретной версии
```

Порядок: бэкап → загрузка версии → сборка → API применяет миграции БД → перезапуск (game-server последним — текущие раунды доигрываются) → смоук-тест (здоровье, каталог, создание комнаты). Если что-то пошло не так — **автоматический откат** к прошлой версии и данным из только что сделанного бэкапа.

## 10. Резервные копии и восстановление

```bash
sudo ./scripts/backup.sh               # БД (консистентный снимок), опубликованные клипы, .env
sudo ./scripts/restore.sh /opt/dubroom/backups/dubroom-daily-….tar.gz.age --identity ~/age-key.txt --with-env
```

- Хранится 7 ежедневных и 4 еженедельных копии (`BACKUP_KEEP_DAILY/WEEKLY`). Записи игроков не бэкапятся — они живут 24 ч.
- **Шифрование:** `age-keygen -o age-key.txt` на *своём* компьютере, публичный ключ (`age1…`) — в `.env` как `BACKUP_AGE_RECIPIENT`. Приватный ключ на сервере не храните.
- **Копия вне сервера (правило 3-2-1):** `BACKUP_S3_URL` + установленный `rclone` или `aws`.
- **Восстановление на новой машине:** `install.sh` → скопировать архив → `restore.sh … --with-env`. Раз в месяц проверяйте восстановление на временной VM.

## 11. Безопасность

Кратко (подробно — [security.md](security.md)):

```bash
sudo ./scripts/harden.sh                    # ОС, SSH, фаервол, Docker, fail2ban, auditd (§22)
sudo ./scripts/security-check.sh            # аудит по чек-листу §22.12
sudo ./scripts/rotate-secrets.sh --all      # раз в 90 дней и при подозрении на утечку
```

- **SSH через Cloudflare Access** (рекомендуется, порт 22 закрыт): Zero Trust → Access → Applications → *Self-hosted* для `ssh.<домен>`, в туннеле Public Hostname `ssh.<домен>` → `ssh://localhost:22`. На своём компьютере в `~/.ssh/config`:
  ```
  Host dubroom
    HostName ssh.example.com
    ProxyCommand cloudflared access ssh --hostname %h
  ```
- **Администраторы:** личные учётки с `sudo`, ключ Ed25519, группа `ssh-admins`. Добавить: `sudo adduser anna && sudo usermod -aG sudo,ssh-admins,docker anna` + её ключ в `~anna/.ssh/authorized_keys`. Удалить: `sudo deluser --remove-home anna` в тот же день.
- **Инцидент:** порядок действий — [security.md → Инцидент](security.md#incident).

## 12. Типовые проблемы

| Симптом | Что проверить |
|---|---|
| Туннель «down» в панели | `./scripts/tunnel.sh info`, `./scripts/logs.sh cloudflared`; токен не отозван? исходящий 443/7844 не закрыт (`harden.sh --strict-egress` разрешает оба) |
| 502 от Cloudflare | сервисы не поднялись: `./scripts/status.sh`, `./scripts/logs.sh caddy` |
| Закончилось место | `df -h`; старые бэкапы — `/opt/dubroom/backups`; черновики Studio — удалить в Studio; `docker system prune` |
| Не грузятся большие файлы в Studio | загрузка идёт частями по 50 МБ; проверьте лимит WAF/правила на `/api/studio/*` и что Studio открыта на `studio.<домен>` |
| WebSocket рвётся | клиент шлёт ping каждые 20 с и переподключается 60 с; проверьте, что правило кеша не трогает `/ws`, и `ALLOWED_ORIGINS` в `.env` совпадает с адресом игры |
| Клип завис «в обработке» | `./scripts/logs.sh media-worker`; зависшие задачи возвращаются в очередь при перезапуске воркера |
| Длинный клип «целиком» заикается | потоковый режим зависит от сети игроков; включите «Длинные клипы → по сценам» или проверьте, что Cloudflare кеширует `/media/*` |
| Видео у части игроков не играет | браузер без H.264 получает VP9-версию автоматически; если клип опубликован до версии 0.1.0 — сделайте новую версию в Studio |

## 13. Удаление

```bash
sudo ./scripts/uninstall.sh            # контейнеры, образы, автозапуск; данные остаются
sudo ./scripts/uninstall.sh --purge    # + все данные (спросит подтверждение)
```

Туннель и Access-приложение удалите в панели Cloudflare.
