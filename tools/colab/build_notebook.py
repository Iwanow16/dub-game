"""Builds DubRoom_Clip_Factory.ipynb from dubroom_factory.py and the cells below.

    python tools/colab/build_notebook.py          # write the notebook
    python tools/colab/build_notebook.py --check  # CI: fail if the notebook is out of date
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "DubRoom_Clip_Factory.ipynb"
REPO = "Iwanow16/dub-game"
COLAB_URL = f"https://colab.research.google.com/github/{REPO}/blob/main/tools/colab/{OUT.name}"


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text: str, form: bool = True) -> dict:
    meta = {"cellView": "form"} if form else {}
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": meta,
        "outputs": [],
        "source": text.strip("\n").splitlines(keepends=True),
    }


INTRO = f"""
# 🎬 DubRoom · фабрика клипов

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)]({COLAB_URL})

Блокнот сам превращает видео — трейлер игры, сцену из фильма, фрагмент серии любой длины — в **готовый клип для DubRoom**:

1. **Источник** — ссылка (YouTube, VK Видео, Rutube и всё, что понимает `yt-dlp`), файл с компьютера или с Google Диска; обрезка по времени.
2. **Голос отдельно от фона** — нейросеть Demucs: в игре звучит музыка и эффекты, а голоса — игроков.
3. **Реплики** — распознавание речи Whisper с точными таймингами слов; короткие читаемые реплики, мусор вроде «Продолжение следует…» отбрасывается.
4. **Роли** — кто говорит: голоса группируются автоматически (ECAPA или pyannote), каждая роль получает цвет.
5. **Сцены** — длинный клип режется на сцены по 5 с…2 мин в паузах диалога, по возможности на склейках кадров.
6. **Проверка** — те же правила, что у сервера, таблица реплик и **превью «как у игрока»**.
7. **Результат** — ZIP-пакет (на Диск или на компьютер) и/или **отправка прямо в Clip Studio** вашего сервера DubRoom.

**Перед запуском:** «Среда выполнения → Сменить среду выполнения → GPU (T4)». Без GPU всё работает, но в 10–30 раз медленнее.
Затем «Среда выполнения → Выполнить все» или ячейки по порядку ▶. Параметры задаются в формах справа от кода.

> ⚖️ **Права.** Публиковать в игре можно только видео, на которое у вас есть права: своё, CC0/CC BY, public domain или письменное разрешение. Укажите источник и лицензию — их проверит модератор.

Ориентир по времени на T4: 10 минут видео ≈ 1–2 мин Demucs + 1–2 мин Whisper large-v3 + обработка на сервере.
"""

INSTALL = """
#@title 1. Установка (≈ 2–3 мин) { display-mode: "form" }
#@markdown Ставит yt-dlp, Demucs, faster-whisper, SpeechBrain (голоса) и PySceneDetect (склейки).
import os, shutil, subprocess, sys

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout[-2000:], r.stderr[-2000:])
        raise RuntimeError(f"не удалось: {cmd}")

sh(f"{sys.executable} -m pip install -q -U 'yt-dlp[default]' demucs faster-whisper speechbrain "
   "scenedetect opencv-python-headless soundfile scikit-learn requests")
# YouTube requires a JavaScript runtime for yt-dlp
if not shutil.which("deno") and not os.path.exists(os.path.expanduser("~/.deno/bin/deno")):
    subprocess.run("curl -fsSL https://deno.land/install.sh | sh -s -- -y > /dev/null 2>&1", shell=True)
os.environ["PATH"] = os.path.expanduser("~/.deno/bin") + os.pathsep + os.environ["PATH"]
if not shutil.which("ffmpeg"):
    sh("apt-get -qq update && apt-get -qq install -y ffmpeg")
subprocess.run("apt-get -qq install -y fonts-dejavu-core > /dev/null 2>&1", shell=True)

import torch
if torch.cuda.is_available():
    print(f"✓ Готово. GPU: {torch.cuda.get_device_name(0)}")
else:
    print("✓ Готово. ⚠ GPU не подключён — будет медленно (Среда выполнения → Сменить среду → T4 GPU)")
"""

MODULE_MD = """
Следующая ячейка — код конвейера (`dubroom_factory.py`). Её не нужно менять — просто запустите ▶.
"""

PARAMS = """
#@title 2. Параметры клипа { display-mode: "form" }
#@markdown ### Источник
SOURCE_KIND = "Ссылка" #@param ["Ссылка", "Файл с компьютера", "Google Диск"]
#@markdown Ссылка на видео — или путь на Диске, например `/content/drive/MyDrive/video.mp4`:
SOURCE = "" #@param {type:"string"}
#@markdown Обрезка (необязательно): `1:05`, `1:05.5`, `0:01:05` или секунды. Пусто — с начала / до конца.
TRIM_START = "" #@param {type:"string"}
TRIM_END = "" #@param {type:"string"}

#@markdown ### Описание
TITLE = "" #@param {type:"string"}
#@markdown Пусто — возьмётся название видео. Источник: автор и ссылка (пусто — возьмутся со страницы видео).
CREDIT = "" #@param {type:"string"}
LICENSE = "Own work" #@param ["Own work", "CC0 1.0", "CC BY 4.0", "CC BY 3.0", "CC BY-SA 4.0", "Public Domain", "Written permission"] {allow-input: true}
AGE_RATING = "12+" #@param ["0+", "12+", "16+"]
TAGS = "" #@param {type:"string"}

#@markdown ### Голос и текст
#@markdown `htdemucs` — быстро, `htdemucs_ft` — чище, но в 4 раза дольше; `none` — фон уже без голоса не нужен (в игре будут слышны оригинальные голоса).
SEPARATION = "htdemucs" #@param ["htdemucs", "htdemucs_ft", "none"]
LANGUAGE = "auto" #@param ["auto", "ru", "en", "uk", "de", "fr", "es", "it", "ja", "ko", "zh"] {allow-input: true}
#@markdown Перевести реплики на английский (для роликов на других языках):
TRANSLATE_TO_ENGLISH = False #@param {type:"boolean"}
WHISPER_MODEL = "large-v3" #@param ["large-v3", "turbo", "medium", "small"]

#@markdown ### Роли
#@markdown `ecapa` — нейросеть без регистрации; `pyannote` — точнее, нужен токен Hugging Face (секрет `HF_TOKEN`); `none` — одна роль.
DIARIZATION = "ecapa" #@param ["ecapa", "pyannote", "mfcc", "none"]
#@markdown Сколько человек говорит (0 — определить автоматически):
SPEAKERS = 0 #@param {type:"slider", min:0, max:6, step:1}
MAX_ROLES = 4 #@param {type:"slider", min:1, max:6, step:1}
#@markdown Имена ролей через запятую — в порядке появления в клипе (пусто — «Голос 1», «Голос 2»…):
ROLE_NAMES = "" #@param {type:"string"}

#@markdown ### Сцены (для клипов длиннее 90 с)
SCENES = True #@param {type:"boolean"}
SHOT_DETECTION = True #@param {type:"boolean"}

WORKDIR = "/content/dubroom"
print("✓ Параметры сохранены")
"""

SOURCE_CELL = """
#@title 3. Источник { display-mode: "form" }
import os
from pathlib import Path

try:
    import google.colab  # noqa: F401
    IN_COLAB = True
except ImportError:
    IN_COLAB = False

if SOURCE_KIND == "Файл с компьютера":
    from google.colab import files
    up = Path(WORKDIR) / "upload"
    up.mkdir(parents=True, exist_ok=True)
    print("Выберите видеофайл…")
    got = files.upload()
    name = next(iter(got))
    (up / name).write_bytes(got[name])
    SOURCE_PATH = str(up / name)
elif SOURCE_KIND == "Google Диск":
    if IN_COLAB and not os.path.exists("/content/drive/MyDrive"):
        from google.colab import drive
        drive.mount("/content/drive")
    SOURCE_PATH = SOURCE.strip()
    if not os.path.exists(SOURCE_PATH):
        raise FileNotFoundError(f"нет файла {SOURCE_PATH} — скопируйте путь из панели «Файлы» слева")
else:
    SOURCE_PATH = SOURCE.strip()
    if not SOURCE_PATH.startswith("http"):
        raise ValueError("вставьте ссылку на видео в поле SOURCE (шаг 2)")
print("✓ Источник:", SOURCE_PATH)
"""

RUN_CELL = """
#@title 4. Создать клип { display-mode: "form" }
#@markdown Повторный запуск не делает заново то, что не менялось: можно поменять число ролей или имена и перезапустить за секунды.
import importlib, subprocess, sys
import dubroom_factory as f
importlib.reload(f)

def secret(name, ask=None):
    try:
        from google.colab import userdata
        v = userdata.get(name)
        if v:
            return v
    except Exception:
        pass
    if os.environ.get(name):
        return os.environ[name]
    if ask:
        import getpass
        return getpass.getpass(ask)
    return ""

hf_token = ""
if DIARIZATION == "pyannote":
    subprocess.run(f"{sys.executable} -m pip install -q pyannote.audio", shell=True)
    hf_token = secret("HF_TOKEN", "Токен Hugging Face (Read): ")

cfg = f.Config(
    source=SOURCE_PATH, title=TITLE, credit=CREDIT, license=LICENSE, age_rating=AGE_RATING,
    tags=TAGS, trim_start=TRIM_START, trim_end=TRIM_END, separation=SEPARATION,
    language="" if LANGUAGE == "auto" else LANGUAGE, translate_to_english=TRANSLATE_TO_ENGLISH,
    whisper_model=WHISPER_MODEL, diarization=DIARIZATION, speakers=SPEAKERS, max_roles=MAX_ROLES,
    role_names=ROLE_NAMES, hf_token=hf_token, scenes=SCENES, shot_detection=SHOT_DETECTION,
    workdir=WORKDIR,
)
PKG, M, ERRORS, WARNINGS = f.make_clip(cfg)
print()
print(f"🎬 «{next(iter(M['title'].values()))}» — {f.fmt_ms(M['durationMs'])}, "
      f"реплик: {len(M['lines'])}, ролей: {len(M['roles'])}, сцен: {len(M.get('scenes') or []) or 1}")
for e in ERRORS:
    print("  ✗", e)
for w in WARNINGS:
    print("  ⚠", w)
print("✓ Пакет готов:" if not ERRORS else "✗ Исправьте ошибки (шаг 2 или 6) и запустите снова:", PKG)
"""

CHECK_CELL = """
#@title 5. Проверка и превью { display-mode: "form" }
#@markdown Превью — как увидит игрок: только фон (без голосов) и цветные реплики. `dialogue` — выделенный голос (проверить разделение), `original` — исходный звук.
PREVIEW_FROM = "0:00" #@param {type:"string"}
PREVIEW_SECONDS = 60 #@param {type:"slider", min:10, max:300, step:10}
PREVIEW_AUDIO = "bed" #@param ["bed", "dialogue", "original"]
import html, json
from IPython.display import HTML, Video, display

M = json.loads((PKG / "manifest.json").read_text("utf-8"))
ERRORS, WARNINGS = f.validate(M)
names = {r["id"]: next(iter(r["name"].values())) for r in M["roles"]}
colors = {r["id"]: r["color"] for r in M["roles"]}
scene_of = {}
for s in M.get("scenes") or []:
    for l in M["lines"]:
        if s["startMs"] <= l["startMs"] < s["endMs"]:
            scene_of[l["id"]] = s["id"]
rows = "".join(
    f"<tr><td>{l['id']}</td><td>{scene_of.get(l['id'], '')}</td><td>{f.fmt_ms(l['startMs'])}</td>"
    f"<td>{(l['endMs'] - l['startMs']) / 1000:.1f} с</td>"
    f"<td style='color:{colors[l['role']]};font-weight:bold'>{html.escape(names[l['role']])}</td>"
    f"<td>{html.escape(next(iter(l['text'].values())))}</td></tr>"
    for l in M["lines"]
)
issues = "".join(f"<li style='color:#d33'>✗ {html.escape(e)}</li>" for e in ERRORS)
issues += "".join(f"<li style='color:#b80'>⚠ {html.escape(w)}</li>" for w in WARNINGS)
display(HTML(
    f"<p><b>Проверки:</b> {'✓ ошибок нет' if not ERRORS else ''}</p><ul>{issues}</ul>"
    "<div style='max-height:420px;overflow:auto'><table><tr><th>#</th><th>сцена</th><th>начало</th>"
    f"<th>длина</th><th>роль</th><th>текст</th></tr>{rows}</table></div>"
))
start = f.parse_time(PREVIEW_FROM) or 0
prev = f.render_preview(PKG, PKG.parent / "preview.mp4", start, PREVIEW_SECONDS * 1000, PREVIEW_AUDIO)
display(Video(str(prev), embed=True, width=640))
"""

EDIT_CELL = """
#@title 6. (Необязательно) Поправить реплики и роли { display-mode: "form" }
#@markdown **Способ 1 — файл.** Отметьте `DOWNLOAD_SRT`, запустите: скачается `subtitles.srt`. Поправьте текст, тайминги и метки ролей `[r1]`, `[r2]`… (подсказка интонации — в скобках в конце: `(шёпотом)`), затем снимите галочку и запустите снова — загрузите файл обратно.
#@markdown
#@markdown **Способ 2 — в Clip Studio.** Отправьте клип в режиме `draft` (шаг 8) и доведите разметку в редакторе: волна, горячие клавиши, сцены.
DOWNLOAD_SRT = True #@param {type:"boolean"}
#@markdown Новые имена ролей через запятую (пусто — оставить):
NEW_ROLE_NAMES = "" #@param {type:"string"}
names_arg = [n for n in NEW_ROLE_NAMES.split(",") if n.strip()] or None
if DOWNLOAD_SRT and IN_COLAB:
    from google.colab import files
    files.download(str(PKG / "subtitles.srt"))
elif DOWNLOAD_SRT:
    print("Файл:", PKG / "subtitles.srt")
else:
    if IN_COLAB:
        from google.colab import files
        print("Выберите исправленный subtitles.srt…")
        got = files.upload()
        text = next(iter(got.values())).decode("utf-8-sig")
    else:
        text = (PKG / "subtitles.srt").read_text("utf-8")
    M, ERRORS, WARNINGS = f.reload_srt(PKG, text, names_arg)
    print(f"✓ Реплик: {len(M['lines'])}, ролей: {len(M['roles'])}")
    for e in ERRORS:
        print("  ✗", e)
    for w in WARNINGS:
        print("  ⚠", w)
if names_arg and DOWNLOAD_SRT:
    M, ERRORS, WARNINGS = f.reload_srt(PKG, (PKG / "subtitles.srt").read_text("utf-8"), names_arg)
    print("✓ Роли:", ", ".join(next(iter(r["name"].values())) for r in M["roles"]))
"""

SAVE_CELL = """
#@title 7. Сохранить пакет { display-mode: "form" }
#@markdown ZIP с `manifest.json`, `subtitles.srt` и исходниками — для `dubroom-clip publish` или ручной загрузки в Clip Studio.
SAVE_TO = "Google Диск" #@param ["Google Диск", "Скачать", "Оставить в Colab"]
DRIVE_FOLDER = "/content/drive/MyDrive/DubRoom" #@param {type:"string"}
import shutil
if ERRORS:
    print("⚠ В пакете есть ошибки — сервер его не примет, пока они не исправлены")
z = f.zip_package(PKG)
print(f"✓ {z.name}: {z.stat().st_size / 1e6:.0f} МБ")
if SAVE_TO == "Google Диск":
    from google.colab import drive
    if not os.path.exists("/content/drive/MyDrive"):
        drive.mount("/content/drive")
    os.makedirs(DRIVE_FOLDER, exist_ok=True)
    shutil.copy(z, DRIVE_FOLDER)
    print("✓ Сохранено:", os.path.join(DRIVE_FOLDER, z.name))
elif SAVE_TO == "Скачать":
    from google.colab import files
    files.download(str(z))
"""

PUBLISH_CELL = """
#@title 8. Отправить в DubRoom { display-mode: "form" }
#@markdown Адрес вашей Clip Studio, например `https://studio.example.com`.
STUDIO_URL = "" #@param {type:"string"}
#@markdown `draft` — загрузить черновик и доделать в Studio; `submit` — на обработку и модерацию; `approve` — сразу опубликовать (только свой проверенный контент).
MODE = "submit" #@param ["draft", "submit", "approve"]
#@markdown Ключ Studio (`STUDIO_KEY` из `.env` сервера) берётся из секрета Colab `STUDIO_KEY` (значок 🔑 слева) или спрашивается.
#@markdown Если Studio закрыта Cloudflare Access — создайте service token и сохраните секреты `CF_ACCESS_CLIENT_ID` и `CF_ACCESS_CLIENT_SECRET`.
if ERRORS:
    raise RuntimeError("в пакете есть ошибки (шаг 5) — исправьте их перед отправкой")
if not STUDIO_URL.startswith("http"):
    raise ValueError("укажите STUDIO_URL")
RESULT = f.publish(
    PKG, STUDIO_URL, secret("STUDIO_KEY", "Ключ Clip Studio: "), MODE,
    secret("CF_ACCESS_CLIENT_ID"), secret("CF_ACCESS_CLIENT_SECRET"),
)
print(RESULT)
"""

BATCH_CELL = """
#@title 9. Пакетный режим: много видео подряд { display-mode: "form" }
#@markdown По одной строке на видео: `ссылка | название | начало | конец` (всё после ссылки — необязательно).
#@markdown Используются настройки шага 2. Каждый пакет сохраняется в ZIP и, если задан `BATCH_MODE`, отправляется в Studio (`STUDIO_URL` из шага 8).
BATCH = \"\"\"
https://www.youtube.com/watch?v=XXXXXXXXXXX | Трейлер | 0:05 | 2:35
\"\"\"
BATCH_MODE = "не отправлять" #@param ["не отправлять", "draft", "submit", "approve"]
BATCH_SAVE_TO_DRIVE = True #@param {type:"boolean"}
import dubroom_factory as f
report = []
for row in [r for r in BATCH.strip().splitlines() if r.strip() and not r.strip().startswith("#")]:
    parts = [p.strip() for p in row.split("|")] + ["", "", ""]
    url, title, a, b = parts[:4]
    print("\\n" + "═" * 60 + f"\\n{url}")
    try:
        c = f.Config(**{**cfg.__dict__, "source": url, "title": title, "trim_start": a, "trim_end": b, "credit": CREDIT})
        pkg, m, errs, warns = f.make_clip(c)
        if errs:
            raise RuntimeError("; ".join(errs))
        z = f.zip_package(pkg)
        if BATCH_SAVE_TO_DRIVE:
            from google.colab import drive
            if not os.path.exists("/content/drive/MyDrive"):
                drive.mount("/content/drive")
            os.makedirs(DRIVE_FOLDER, exist_ok=True)
            shutil.copy(z, DRIVE_FOLDER)
        status = "zip"
        if BATCH_MODE != "не отправлять":
            status = f.publish(pkg, STUDIO_URL, secret("STUDIO_KEY", "Ключ Clip Studio: "), BATCH_MODE,
                               secret("CF_ACCESS_CLIENT_ID"), secret("CF_ACCESS_CLIENT_SECRET"))["status"]
        report.append((url, "✓ " + status, len(m["lines"]), len(m["roles"])))
    except Exception as e:  # keep going with the next video
        report.append((url, f"✗ {e}", 0, 0))
print("\\n" + "\\n".join(f"{s:<40} реплик {n:<4} ролей {r}  {u}" for u, s, n, r in report))
"""

HELP = """
## Если что-то пошло не так

| Проблема | Что сделать |
|---|---|
| `CUDA out of memory` | `SEPARATION = htdemucs` вместо `_ft`, `WHISPER_MODEL = turbo` или `medium`; «Среда выполнения → Перезапустить сеанс» |
| YouTube: `Sign in to confirm you're not a bot` | скачайте видео сами и выберите «Файл с компьютера» или «Google Диск» |
| Роли перепутаны | задайте точное число говорящих `SPEAKERS`; для сложных сцен — `DIARIZATION = pyannote`; или поправьте метки `[r1]`/`[r2]` в SRT (шаг 6) |
| pyannote не загружается | на huggingface.co примите условия `pyannote/speaker-diarization-community-1` (или `-3.1`) и сохраните токен в секрет `HF_TOKEN` |
| Реплики «слиплись» или разорваны | правка в SRT (шаг 6) или в Clip Studio (режим `draft`) |
| В фоне слышен голос | `SEPARATION = htdemucs_ft`; остатки приглушите в Audacity и загрузите `bed` в Studio |
| «разрешение исходника … нужно ≥ 480p» | найдите версию видео качественнее |
| Studio отвечает страницей входа | Studio за Cloudflare Access: service token → секреты `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, и добавьте токен в политику приложения (Service Auth) |

Подробнее — [руководство автора](https://github.com/Iwanow16/dub-game/blob/main/docs/user/author.md) · формат пакета — `dubroom.clip/1`.
"""


def build() -> dict:
    module = (HERE / "dubroom_factory.py").read_text("utf-8")
    cells = [
        md(INTRO),
        code(INSTALL),
        md(MODULE_MD),
        code("%%writefile dubroom_factory.py\n" + module, form=False),
        code(PARAMS),
        code(SOURCE_CELL),
        code(RUN_CELL),
        code(CHECK_CELL),
        code(EDIT_CELL),
        code(SAVE_CELL),
        code(PUBLISH_CELL),
        code(BATCH_CELL),
        md(HELP),
    ]
    return {
        "cells": cells,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"provenance": [], "gpuType": "T4", "toc_visible": True},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 0,
    }


def main() -> int:
    text = json.dumps(build(), ensure_ascii=False, indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text("utf-8") != text:
            print(f"{OUT.name} устарел: запустите python tools/colab/build_notebook.py", file=sys.stderr)
            return 1
        print(f"✓ {OUT.name} актуален")
        return 0
    OUT.write_text(text, "utf-8")
    print(f"✓ {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
