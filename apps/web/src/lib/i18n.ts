import { useCallback } from "react";
import { create } from "zustand";
import { load, save } from "./storage.ts";

/**
 * Interface strings (§20.7): ICU MessageFormat subset — `{name}` and
 * `{n, plural, one {…} few {…} many {…} other {…}}` with `#` for the number.
 */
export type Lang = "ru" | "en";

const ru = {
  "app.tagline": "Переозвучь кино с друзьями — прямо в браузере",
  "home.create": "Создать комнату",
  "home.codeLabel": "Код комнаты",
  "home.join": "Войти",
  "home.howto": "Как играть?",
  "home.try": "Попробовать одному",
  "home.badCode": "Код — 5 букв и цифр, без 0/O и 1/I",
  "profile.title": "Кто ты сегодня?",
  "profile.name": "Имя",
  "profile.random": "🎲 Случайно",
  "profile.presets": "Готовые",
  "profile.next": "Далее →",
  "profile.back": "← Назад",
  "profile.err.length": "Имя — от 2 до 20 символов",
  "profile.err.profanity": "Давай без этого слова 🙂",
  "sound.title": "Проверка звука",
  "sound.headphones": "Я в наушниках",
  "sound.headphonesHint": "С наушниками запись чище: фон не попадает в микрофон.",
  "sound.noHeadphones": "Без наушников включим эхоподавление и приглушим фон.",
  "sound.micAsk": "Разрешить микрофон",
  "sound.micWhy":
    "Микрофон нужен, чтобы записать твой дубляж. Запись видят только участники комнаты и она удаляется через сутки.",
  "sound.say": "Скажи что-нибудь — полоски должны прыгать",
  "sound.calibrate": "Калибровка задержки",
  "sound.calibrateHint":
    "Хлопни в ладоши в такт 4 щелчкам. Это нужно один раз — так голос точно совпадёт с губами.",
  "sound.calibrateStart": "Начать калибровку",
  "sound.calibrated": "Задержка: {ms} мс",
  "sound.calibrateFail": "Не расслышали хлопки — попробуй громче или пропусти",
  "sound.skip": "Пропустить",
  "sound.continue": "Готово",
  "mic.denied": "Доступ к микрофону запрещён",
  "mic.denied.chrome":
    "Chrome/Edge: нажми на значок 🔒 слева от адреса → «Микрофон» → «Разрешить», затем обнови страницу.",
  "mic.denied.firefox": "Firefox: нажми на значок микрофона в адресной строке → «Разрешить».",
  "mic.denied.safari": "Safari: «Safari» → «Настройки для этого сайта» → «Микрофон» → «Разрешить».",
  "mic.not_found": "Микрофон не найден — подключи его и попробуй снова",
  "mic.busy": "Микрофон занят другой программой",
  "mic.insecure": "Микрофон работает только по HTTPS",
  "mic.unsupported": "Этот браузер не умеет записывать звук — попробуй Chrome, Firefox или Safari",
  "mic.retry": "Попробовать снова",
  "lobby.copy": "⧉ Скопировать ссылку",
  "lobby.copied": "Ссылка скопирована",
  "lobby.qr": "QR",
  "lobby.players": "Игроки {n}/6",
  "lobby.spectators":
    "{n, plural, one {+ # зритель} few {+ # зрителя} many {+ # зрителей} other {+ # зрителя}}",
  "lobby.settings": "Настройки комнаты",
  "lobby.start": "Начать игру",
  "lobby.needTwo": "Нужно минимум 2 игрока",
  "lobby.waitHost": "Ждём, когда хост начнёт игру",
  "lobby.beSpectator": "Смотреть как зритель",
  "lobby.bePlayer": "Играть",
  "lobby.kick": "Выгнать",
  "lobby.rename": "Переименовать",
  "lobby.youAreSpectator": "Ты зритель: смотришь и голосуешь",
  "settings.rounds": "Раунды",
  "settings.mode": "Режим",
  "settings.mode.classic": "Классика",
  "settings.mode.roles": "Командный дубляж",
  "settings.mode.improv": "Импровизация",
  "settings.rating": "Рейтинг клипов",
  "settings.anonymous": "Анонимно",
  "settings.pick": "Выбор клипа",
  "settings.pick.vote": "Голосование",
  "settings.pick.host": "Хост выбирает",
  "settings.relaxed": "Без спешки (таймеры ×3)",
  "settings.locked": "Не пускать новых во время игры",
  "phase.pick": "Раунд {r}/{total} · Выбор клипа",
  "phase.record": "Раунд {r}/{total} · Запись",
  "phase.watch": "Раунд {r}/{total} · Дубль {i} из {n}",
  "phase.vote": "Раунд {r}/{total} · Голосование",
  "phase.results": "Раунд {r}/{total} · Итоги",
  "phase.final": "Финал",
  "wait.for": "Ждём: {names}",
  "pick.vote": "Голосуйте за клип",
  "pick.host": "Хост выбирает клип",
  "pick.roles": "{n, plural, one {# роль} few {# роли} many {# ролей} other {# роли}}",
  "pick.sec": "{n} с",
  "rec.loading": "Загружаем клип…",
  "rec.rehearse": "Репетиция",
  "rec.skipRehearsal": "Сразу к записи",
  "rec.start": "● Записать",
  "rec.attempt": "Попытка {a}/2",
  "rec.stop": "■ Стоп",
  "rec.restart": "↺ Заново",
  "rec.cantHear": "Тебя не слышно — проверь микрофон",
  "rec.next": "Следующая: {who} — «{text}» через {s} с",
  "rec.yourRoles": "Твои роли: {roles}",
  "rec.review": "Прослушай дубль",
  "rec.rerecord": "↺ Перезаписать ({n} осталось)",
  "rec.send": "✓ Отправить",
  "rec.uploading": "Отправляем… {p}%",
  "rec.uploadFail": "Не удалось отправить запись",
  "rec.done": "Готово! Ждём остальных",
  "rec.spectator": "Игроки записывают дубляж…",
  "rec.privacy": "Запись доступна только участникам комнаты и удаляется через сутки.",
  "rec.effect": "Эффект",
  "rec.sync": "Синхронизация",
  "rec.rotate": "Поверни телефон горизонтально — так удобнее",
  "tip.line": "Здесь появляется реплика. Полоска заполняется перед началом.",
  "tip.meter": "Это уровень микрофона. Если он не прыгает — тебя не слышно.",
  "tip.redo": "Не понравилось? Можно перезаписать один раз.",
  "tip.ok": "Понятно",
  "watch.speaking": "{name} говорит…",
  "watch.take": "Дубль {n}",
  "watch.lost": "Запись потерялась в пути",
  "vote.title": "Голосование",
  "vote.hint": "Нажми на лучший — можно передумать до конца таймера",
  "vote.you": "Это ты",
  "vote.replay": "▶",
  "vote.voted": "Голос принят",
  "vote.spectator": "Твой голос весит ½",
  "results.best":
    "🏆 Лучший дубль раунда: {name} ({n, plural, one {# голос} few {# голоса} many {# голосов} other {# голоса}})",
  "results.noVotes": "В этом раунде никто не проголосовал",
  "results.audience": "Приз зрительских симпатий: {name}",
  "report.button": "⚑ Пожаловаться",
  "report.title": "Жалоба",
  "report.clip": "На клип (права, содержание)",
  "report.player": "На игрока",
  "report.reason": "Что не так?",
  "report.send": "Отправить",
  "report.sent": "Спасибо, модераторы посмотрят",
  "final.title": "Финал",
  "final.rewatch": "▶ Пересмотреть лучший дубль",
  "final.again": "Играть ещё",
  "final.exit": "Выйти",
  "final.winner": "Победитель — {name}!",
  "conn.reconnecting": "Переподключаемся… {s} с",
  "conn.lost": "Связь потеряна",
  "conn.retry": "Переподключиться",
  "err.room_not_found": "Комната не найдена",
  "err.room_full": "Комната заполнена",
  "err.room_locked": "Игра уже идёт, и хост закрыл вход",
  "err.kicked": "Хост удалил тебя из комнаты",
  "err.rate_limited": "Слишком часто — подожди немного",
  "err.bad_name": "Имя не подходит",
  "err.generic": "Что-то пошло не так",
  "err.create": "Не удалось создать комнату",
  "err.faq": "Решение проблем",
  "nf.title": "Комната не найдена",
  "nf.text": "Возможно, код с опечаткой или игра уже закончилась.",
  "nf.home": "На главную",
  "settings.title": "Настройки",
  "settings.lang": "Язык",
  "settings.subs": "Размер субтитров",
  "settings.quality": "Качество видео",
  "settings.quality.auto": "Авто",
  "settings.sounds": "Звуки интерфейса",
  "settings.theme": "Светлая тема",
  "settings.recalibrate": "Перекалибровать звук",
  "help.link": "Справка",
  "practice.title": "Тренировка",
  "practice.hint": "Запиши дубль без комнаты — проверь микрофон и синхронизацию.",
  "practice.again": "Ещё раз",
  "practice.empty": "В библиотеке пока нет клипов",
  "facts.1": "В оригинальном дубляже актёры часто записывают реплику 5–10 раз.",
  "facts.2": "Губы читаются лучше всего на звуках «п», «б» и «м».",
  "facts.3": "Эффект «Робот» — это кольцевая модуляция, как у далеков в 1963 году.",
  "facts.4": "Хлопушку на съёмках используют, чтобы синхронизировать звук и картинку.",
} as const;

export type MsgKey = keyof typeof ru;

const en: Record<MsgKey, string> = {
  "app.tagline": "Re-dub movie clips with friends — right in the browser",
  "home.create": "Create room",
  "home.codeLabel": "Room code",
  "home.join": "Join",
  "home.howto": "How to play?",
  "home.try": "Practice solo",
  "home.badCode": "5 letters/digits, no 0/O or 1/I",
  "profile.title": "Who are you today?",
  "profile.name": "Name",
  "profile.random": "🎲 Random",
  "profile.presets": "Presets",
  "profile.next": "Next →",
  "profile.back": "← Back",
  "profile.err.length": "Name must be 2–20 characters",
  "profile.err.profanity": "Let's keep it friendly 🙂",
  "sound.title": "Sound check",
  "sound.headphones": "I'm wearing headphones",
  "sound.headphonesHint": "Headphones give a cleaner take: the music doesn't leak into the mic.",
  "sound.noHeadphones": "Without headphones we enable echo cancellation and lower the music.",
  "sound.micAsk": "Allow microphone",
  "sound.micWhy":
    "We need the mic to record your dub. Only room members hear it, and it's deleted after 24 hours.",
  "sound.say": "Say something — the bars should move",
  "sound.calibrate": "Latency calibration",
  "sound.calibrateHint": "Clap along with 4 clicks. Needed once, so your voice lands on the lips.",
  "sound.calibrateStart": "Start calibration",
  "sound.calibrated": "Latency: {ms} ms",
  "sound.calibrateFail": "Couldn't hear the claps — try louder or skip",
  "sound.skip": "Skip",
  "sound.continue": "Done",
  "mic.denied": "Microphone access is blocked",
  "mic.denied.chrome":
    "Chrome/Edge: click 🔒 left of the address → Microphone → Allow, then reload.",
  "mic.denied.firefox": "Firefox: click the microphone icon in the address bar → Allow.",
  "mic.denied.safari": "Safari: Safari → Settings for This Website → Microphone → Allow.",
  "mic.not_found": "No microphone found — plug one in and retry",
  "mic.busy": "The microphone is used by another app",
  "mic.insecure": "The microphone only works over HTTPS",
  "mic.unsupported": "This browser can't record audio — try Chrome, Firefox or Safari",
  "mic.retry": "Try again",
  "lobby.copy": "⧉ Copy link",
  "lobby.copied": "Link copied",
  "lobby.qr": "QR",
  "lobby.players": "Players {n}/6",
  "lobby.spectators": "{n, plural, one {+ # spectator} other {+ # spectators}}",
  "lobby.settings": "Room settings",
  "lobby.start": "Start game",
  "lobby.needTwo": "At least 2 players needed",
  "lobby.waitHost": "Waiting for the host to start",
  "lobby.beSpectator": "Watch as spectator",
  "lobby.bePlayer": "Play",
  "lobby.kick": "Kick",
  "lobby.rename": "Rename",
  "lobby.youAreSpectator": "You're a spectator: watch and vote",
  "settings.rounds": "Rounds",
  "settings.mode": "Mode",
  "settings.mode.classic": "Classic",
  "settings.mode.roles": "Team dub",
  "settings.mode.improv": "Improv",
  "settings.rating": "Clip rating",
  "settings.anonymous": "Anonymous",
  "settings.pick": "Clip choice",
  "settings.pick.vote": "Vote",
  "settings.pick.host": "Host picks",
  "settings.relaxed": "No rush (timers ×3)",
  "settings.locked": "Lock room during the game",
  "phase.pick": "Round {r}/{total} · Pick a clip",
  "phase.record": "Round {r}/{total} · Recording",
  "phase.watch": "Round {r}/{total} · Take {i} of {n}",
  "phase.vote": "Round {r}/{total} · Voting",
  "phase.results": "Round {r}/{total} · Results",
  "phase.final": "Final",
  "wait.for": "Waiting for: {names}",
  "pick.vote": "Vote for a clip",
  "pick.host": "The host picks a clip",
  "pick.roles": "{n, plural, one {# role} other {# roles}}",
  "pick.sec": "{n} s",
  "rec.loading": "Loading the clip…",
  "rec.rehearse": "Rehearse",
  "rec.skipRehearsal": "Straight to recording",
  "rec.start": "● Record",
  "rec.attempt": "Take {a}/2",
  "rec.stop": "■ Stop",
  "rec.restart": "↺ Restart",
  "rec.cantHear": "We can't hear you — check the mic",
  "rec.next": "Next: {who} — “{text}” in {s} s",
  "rec.yourRoles": "Your roles: {roles}",
  "rec.review": "Listen back",
  "rec.rerecord": "↺ Re-record ({n} left)",
  "rec.send": "✓ Send",
  "rec.uploading": "Sending… {p}%",
  "rec.uploadFail": "Upload failed",
  "rec.done": "Done! Waiting for the others",
  "rec.spectator": "Players are recording…",
  "rec.privacy": "Only room members hear this take; it's deleted after 24 hours.",
  "rec.effect": "Effect",
  "rec.sync": "Sync",
  "rec.rotate": "Rotate your phone to landscape",
  "tip.line": "The current line shows here. The bar fills up right before it starts.",
  "tip.meter": "Your mic level. If it doesn't move, we can't hear you.",
  "tip.redo": "Didn't like it? You can re-record once.",
  "tip.ok": "Got it",
  "watch.speaking": "{name} is speaking…",
  "watch.take": "Take {n}",
  "watch.lost": "This recording got lost on the way",
  "vote.title": "Voting",
  "vote.hint": "Tap the best one — you can change your mind until the timer ends",
  "vote.you": "That's you",
  "vote.replay": "▶",
  "vote.voted": "Vote counted",
  "vote.spectator": "Your vote counts ½",
  "results.best": "🏆 Best take: {name} ({n, plural, one {# vote} other {# votes}})",
  "results.noVotes": "Nobody voted this round",
  "results.audience": "Audience award: {name}",
  "report.button": "⚑ Report",
  "report.title": "Report",
  "report.clip": "The clip (rights, content)",
  "report.player": "A player",
  "report.reason": "What's wrong?",
  "report.send": "Send",
  "report.sent": "Thanks, moderators will take a look",
  "final.title": "Final",
  "final.rewatch": "▶ Rewatch the best take",
  "final.again": "Play again",
  "final.exit": "Leave",
  "final.winner": "The winner is {name}!",
  "conn.reconnecting": "Reconnecting… {s} s",
  "conn.lost": "Connection lost",
  "conn.retry": "Reconnect",
  "err.room_not_found": "Room not found",
  "err.room_full": "The room is full",
  "err.room_locked": "The game is running and the host locked the room",
  "err.kicked": "The host removed you from the room",
  "err.rate_limited": "Too fast — wait a moment",
  "err.bad_name": "This name won't work",
  "err.generic": "Something went wrong",
  "err.create": "Couldn't create a room",
  "err.faq": "Troubleshooting",
  "nf.title": "Room not found",
  "nf.text": "Maybe the code has a typo or the game is over.",
  "nf.home": "Home",
  "settings.title": "Settings",
  "settings.lang": "Language",
  "settings.subs": "Subtitle size",
  "settings.quality": "Video quality",
  "settings.quality.auto": "Auto",
  "settings.sounds": "Interface sounds",
  "settings.theme": "Light theme",
  "settings.recalibrate": "Recalibrate sound",
  "help.link": "Help",
  "practice.title": "Practice",
  "practice.hint": "Record a take without a room — check your mic and sync.",
  "practice.again": "Again",
  "practice.empty": "The library has no clips yet",
  "facts.1": "Professional dubbing actors often record a line 5–10 times.",
  "facts.2": "Lips are easiest to read on “p”, “b” and “m”.",
  "facts.3": "The Robot effect is ring modulation — like the Daleks in 1963.",
  "facts.4": "Film crews use a clapperboard to sync sound and picture.",
};

const dicts: Record<Lang, Record<MsgKey, string>> = { ru, en };

type Params = Record<string, string | number>;

function plural(lang: Lang, n: number, forms: Record<string, string>): string {
  const cat = new Intl.PluralRules(lang).select(n);
  return (forms[cat] ?? forms.other ?? "").replace(/#/g, String(n));
}

/** Formats one message; exported for tests. */
export function format(lang: Lang, template: string, params: Params = {}): string {
  // plural blocks: {n, plural, one {..} few {..} other {..}}
  let out = "";
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf("{", i);
    if (start < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, start);
    // find matching brace
    let depth = 0;
    let j = start;
    for (; j < template.length; j++) {
      if (template[j] === "{") depth++;
      else if (template[j] === "}" && --depth === 0) break;
    }
    const body = template.slice(start + 1, j);
    const m = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(body);
    if (m) {
      const n = Number(params[m[1]!] ?? 0);
      const forms: Record<string, string> = {};
      for (const f of m[2]!.matchAll(/(\w+)\s*\{([^{}]*)\}/g)) forms[f[1]!] = f[2]!;
      out += plural(lang, n, forms);
    } else {
      out += String(params[body.trim()] ?? `{${body}}`);
    }
    i = j + 1;
  }
  return out;
}

function detect(): Lang {
  const saved = load<Lang | null>("lang", null);
  if (saved === "ru" || saved === "en") return saved;
  return typeof navigator !== "undefined" && navigator.language.startsWith("ru") ? "ru" : "en";
}

export const useLang = create<{ lang: Lang; setLang: (l: Lang) => void }>((set) => ({
  lang: detect(),
  setLang: (lang) => {
    save("lang", lang);
    document.documentElement.lang = lang;
    set({ lang });
  },
}));

export function t(key: MsgKey, params?: Params): string {
  const lang = useLang.getState().lang;
  return format(lang, dicts[lang][key] ?? ru[key], params);
}

/** Hook form so components re-render on language change. */
export function useT() {
  const lang = useLang((s) => s.lang);
  return useCallback(
    (key: MsgKey, params?: Params) => format(lang, dicts[lang][key] ?? ru[key], params),
    [lang],
  );
}
