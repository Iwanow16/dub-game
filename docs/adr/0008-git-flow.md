# ADR-0008: Git Flow и Conventional Commits
Статус: принято

Решение: ветки `main` (только релизы с тегами), `develop` (интеграция), `feature/*`, `fix/*`, `release/*`, `hotfix/*`; слияние `--no-ff`; сообщения по Conventional Commits со scope пакета. Подробности — [CONTRIBUTING.md](../../CONTRIBUTING.md).

Последствия: + история фич читается по merge-коммитам, CHANGELOG собирается из типов коммитов; − больше веток, чем при trunk-based. При переходе на непрерывную поставку можно упростить до GitHub Flow.
