# Architecture Decision Records

Шаблон — [plan.md, приложение B](../plan.md#b-шаблон-adr-architecture-decision-record). Новое решение — новый файл `NNNN-кратко.md`; принятые ADR не переписываются, а заменяются новыми.

| № | Решение | Статус |
|---|---|---|
| [0001](0001-monorepo-react-vite.md) | Монорепозиторий pnpm, TypeScript, React + Vite | принято |
| [0002](0002-own-websocket-protocol.md) | `ws` + собственный протокол вместо Colyseus | принято |
| [0003](0003-sqlite-and-filesystem-for-mvp.md) | SQLite и файловое хранилище вместо PostgreSQL/Redis/MinIO на MVP | принято |
| [0004](0004-mediarecorder-for-mvp.md) | MediaRecorder вместо AudioWorklet + WebCodecs для записи | принято |
| [0005](0005-progressive-mp4-with-vp9-fallback.md) | Прогрессивный MP4 + VP9/WebM вместо HLS | принято |
| [0006](0006-upload-tickets-and-dub-receipts.md) | Подписанные тикеты и квитанции вместо presigned URL | принято |
| [0007](0007-synthetic-starter-pack.md) | Синтетический стартовый набор клипов в git | принято |
| [0008](0008-git-flow.md) | Git Flow и Conventional Commits | принято |
| [0009](0009-long-clips-scenes-and-streaming.md) | Клипы любой длины: сцены и потоковый режим | принято |
