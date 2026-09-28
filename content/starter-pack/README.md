# Стартовый набор клипов

Пять коротких сцен для первой игры. В git хранятся только **манифесты** (реплики, роли, тайминги)
и **рецепты** `synth.json`: видео и фоновая музыка генерируются FFmpeg-ом при импорте
(`dubroom-clip synth`), поэтому репозиторий остаётся лёгким, а лицензия — CC0.

Импорт на сервер:

```bash
./scripts/seed-clips.sh content/starter-pack --approve   # или: pnpm seed
```

Чтобы заменить сцены настоящими клипами (например, из Blender Open Movies, CC BY), положите
`source/original.mp4` (+ `source/bed.wav`) рядом с манифестом и обновите `credit`/`license` —
см. [docs/user/author.md](../../docs/user/author.md).
