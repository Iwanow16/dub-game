# Как вносить изменения

## Ветки (Git Flow)

| Ветка | Назначение | Откуда | Куда вливается |
|---|---|---|---|
| `main` | Только релизы; каждый коммит — тег `vX.Y.Z` | — | — |
| `develop` | Интеграционная ветка, всегда собирается и проходит тесты | `main` | `release/*` |
| `feature/<кратко>` | Новая функция или задача | `develop` | `develop` (PR, `--no-ff`) |
| `release/<X.Y.Z>` | Стабилизация релиза: версия, CHANGELOG, только фиксы | `develop` | `main` + `develop` |
| `hotfix/<X.Y.Z>` | Срочное исправление в проде | `main` | `main` + `develop` |

Правила:
- Прямые коммиты в `main` и `develop` запрещены — только через PR с ревью и зелёным CI.
- Слияние feature → develop — merge-коммитом (`--no-ff`), чтобы история фичи оставалась видимой.
- Ветку удаляем после слияния.
- Релиз: `git checkout -b release/0.2.0 develop` → поднять версию и CHANGELOG → PR в `main` →
  тег `v0.2.0` → слить `release/0.2.0` обратно в `develop`.

## Сообщения коммитов (Conventional Commits)

```
<type>(<scope>): <кратко, в повелительном наклонении>

<подробности — зачем, а не что>
```
`type`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `security`.
`scope`: имя пакета/приложения — `web`, `studio`, `api`, `game-server`, `media-worker`, `shared`,
`clip-format`, `audio`, `ui`, `infra`, `scripts`, `docs`.

## Definition of Done (§17 плана)

- [ ] `pnpm check` зелёный (format, lint, typecheck, unit-тесты)
- [ ] Новые скрипты проходят `shellcheck`
- [ ] Проверено в Chrome и Safari (для клиентских изменений)
- [ ] Обновлены инструкции в `docs/` (пользовательские и/или администратора)
- [ ] Новые сервисы соответствуют `docs/admin/security.md` (§22 плана)
- [ ] Изменения конфигурации отражены в `scripts/` и `.env.example`

## Локальная разработка

```bash
pnpm install
./scripts/dev.sh        # api + game-server + web + studio с hot-reload
pnpm check              # всё, что проверяет CI
```
