# ADR-0004: MediaRecorder вместо AudioWorklet + WebCodecs для записи
Статус: принято

Контекст: §12.1 предлагает запись сырого PCM через AudioWorklet и кодирование WebCodecs. WebCodecs `AudioEncoder` в Safari появился недавно и работает нестабильно.

Решение: MVP пишет через **MediaRecorder** (Opus/WebM, в Safari — AAC/MP4). Момент старта записи берётся из события `onstart` (`performance.now()`), момент старта клипа — из часов AudioContext через `getOutputTimestamp()`. Смещение считается по формуле §12.2: `offset = recStart − clipStart − roundTripLatency + manual`, задержка измеряется калибровкой по хлопкам. Голос хранится «сухим», эффект применяется при воспроизведении.

Последствия: + работает во всех целевых браузерах; − точность старта MediaRecorder ~10–20 мс хуже, чем у AudioWorklet. Компенсируется калибровкой и ползунком ±200 мс. Метрика §19 («≤ 5 % игроков сдвигают > 100 мс») покажет, нужен ли AudioWorklet-путь.
