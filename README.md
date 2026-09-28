# DubRoom

Браузерная многопользовательская игра в жанре «переозвучка клипов»: открываешь ссылку, вводишь имя, собираешь аватар — и переозвучиваешь кино вместе с друзьями. До 6 игроков и зрители, голосовые эффекты, голосование, без регистрации и установки.

- 📄 План проекта — [docs/plan.md](docs/plan.md)
- 🎮 Как играть — [docs/user/index.md](docs/user/index.md) (в игре — `/help`)
- 🎬 Как сделать свой клип — [docs/user/author.md](docs/user/author.md)
- 🛠 Развернуть на своём сервере — [docs/admin/README.md](docs/admin/README.md)
- 🔐 Безопасность сервера — [docs/admin/security.md](docs/admin/security.md)
- 🧭 Архитектурные решения — [docs/adr](docs/adr/README.md)
- 🤝 Как вносить изменения (Git Flow) — [CONTRIBUTING.md](CONTRIBUTING.md)

## Быстрый старт для разработчика

Нужны Node.js 22+, pnpm 10 и FFmpeg (для обработки клипов).

```bash
pnpm install
./scripts/dev.sh --seed      # api, game-server, media-worker, web, studio, help + 5 стартовых клипов
```

| Что | Адрес |
|---|---|
| Игра | http://localhost:5173 |
| Clip Studio | http://localhost:5174 (ключ — `STUDIO_KEY` в `.env.dev`) |
| Справка | http://localhost:5173/help/ |

`./scripts/dev.sh --tunnel` дополнительно откроет быстрый Cloudflare-туннель, чтобы поиграть с телефона.

```bash
pnpm check        # format, lint, typecheck, unit + интеграционные тесты
pnpm e2e          # Playwright: 3 игрока с фейковыми микрофонами играют раунд; сценарий автора в Studio
make help         # все команды
```

## Архитектура

```
Браузер (web, studio) ──HTTPS/WSS──▶ Cloudflare ──tunnel──▶ cloudflared ─▶ Caddy
                                                              ├─ /            web (SPA)
                                                              ├─ /ws, /api/rooms  game-server  (комнаты в памяти, таймеры, голосование)
                                                              ├─ /api/*       api  (гости, каталог, дубли, Studio API) ──▶ SQLite
                                                              ├─ /media/clips файлы пакетов клипов (immutable-кеш)
                                                              └─ /help        справка
                                          media-worker (без сети): FFmpeg-конвейер клипов, превью для Studio
```

| Пакет | Назначение |
|---|---|
| `apps/web` | игровой клиент: React + Vite, Web Audio, MediaRecorder, Service Worker |
| `apps/studio` | Clip Studio: загрузка, обрезка, разметка реплик, проверка, экспорт, модерация |
| `apps/api` | REST API (Fastify): гостевые токены, каталог, загрузка дублей, Studio API |
| `apps/game-server` | авторитетный WebSocket-сервер комнат (`ws`) |
| `apps/media-worker` | обработка клипов: лестница качеств, фон, постер, превью, субтитры |
| `apps/help` | сборка справки из `docs/user` + проверка ссылок |
| `packages/shared` | протокол, правила игры (очки, команды, выбор клипа), токены |
| `packages/clip-format` | схема манифеста, валидатор, FFmpeg-конвейер, CLI `dubroom-clip` |
| `packages/audio` | эффекты голоса, запись, микшер, калибровка задержки |
| `packages/ui` | дизайн-токены и компоненты, аватар-конструктор |
| `packages/db` | схема и запросы SQLite (§7) |
| `infra`, `scripts` | Docker, Caddy, cloudflared, скрипты установки/эксплуатации (§21–22) |

### Протокол

Клиент ↔ game-server — JSON по WebSocket (§6.4). Сообщения клиента валидируются Zod (`packages/shared/src/protocol.ts`), сервер после каждого изменения шлёт каждому участнику персональный снимок комнаты. Часы синхронизируются NTP-подобным пингом, воспроизведение дублей стартует по `playAt` в серверном времени.

### Формат клипа

Пакет = манифест `dubroom.clip/1` (роли, реплики с таймингами, медиа) + видео без звука в нескольких качествах + фоновая дорожка. Подробно — §8 плана и [руководство автора](docs/user/author.md).

### Как добавить…

- **голосовой эффект** — `packages/audio/src/effects.ts` (`createEffect`) + id в `EFFECTS` (`packages/shared/src/game.ts`) + подпись в `EFFECT_LABELS`;
- **режим игры** — `GAME_MODES` и правила в `packages/shared/src/game.ts`, ветка в `Room.endPick/endRecord` (`apps/game-server/src/room.ts`), тесты в `room.test.ts`;
- **строку интерфейса** — `apps/web/src/lib/i18n.ts` (RU и EN, ICU-плюрализация).

## Лицензия

Код — MIT. Стартовые клипы — CC0 (синтетические сцены, [ADR-0007](docs/adr/0007-synthetic-starter-pack.md)).
