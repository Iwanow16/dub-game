"""DubRoom Clip Factory — automatic clip packages for DubRoom.

Pipeline (docs/user/author.md, ADR-0009): source video (YouTube/any yt-dlp site, upload, Drive)
→ trim → voice/background separation (Demucs) → speech recognition with word timings
(faster-whisper) → lines → speaker roles (ECAPA clustering or pyannote) → scenes at pauses and shot
cuts → manifest checks → preview → package zip and/or upload to Clip Studio.

The package layout is the one `dubroom-clip init/publish` uses:
    <dir>/manifest.json, <dir>/source/original.mp4, source/bed.flac, source/dialogue.flac,
    <dir>/subtitles.srt ("[r1] text" cues — importable in Clip Studio, step «Реплики»).

Used by DubRoom_Clip_Factory.ipynb; also works as a plain module (python -m / import).
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import shutil
import string
import subprocess
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

# ---------------------------------------------------------------------------------------------
# Constants mirrored from packages/clip-format (manifest.ts, scenes.ts, validate.ts)
# ---------------------------------------------------------------------------------------------

MANIFEST_SCHEMA = "dubroom.clip/1"
ROLE_COLORS = ["#FF8A3D", "#3DA5FF", "#3DDC97", "#FF6FB5", "#FFC23D", "#B37BFF"]
AGE_RATINGS = ["0+", "12+", "16+"]
KNOWN_LICENSES = [
    "CC0 1.0",
    "CC BY 4.0",
    "CC BY 3.0",
    "CC BY-SA 4.0",
    "Public Domain",
    "Own work",
    "Written permission",
]
SCENE_MIN_MS = 5_000
SCENE_MAX_MS = 120_000
SCENE_AUTO_ABOVE_MS = 90_000
SCENE_TARGET_MS = 45_000
GRID_MS = 2_000
MIN_DURATION_MS = 5_000
MAX_DURATION_MS = 3 * 3600_000
MIN_LINE_MS = 300
MAX_ROLES = 6
TEXT_MAX = 200
#: the Studio API accepts sources up to 2 GiB; keep a margin
MAX_SOURCE_BYTES = int(1.9 * 1024**3)
#: upload chunk — stays under Cloudflare's 100 MB request limit
CHUNK_BYTES = 50 * 1024 * 1024

#: phrases speech recognisers hallucinate on music and silence
HALLUCINATIONS = [
    r"субтитры (сделал|создавал|подготовил)",
    r"редактор субтитров",
    r"продолжение следует",
    r"спасибо за просмотр",
    r"подписывайтесь на канал",
    r"thanks? (you )?for watching",
    r"please subscribe",
    r"subtitles by",
    r"amara\.org",
    r"^\W*$",
]

Log = Callable[[str], None]


def _log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def run(cmd: list[str], *, quiet: bool = True, timeout: float | None = None) -> str:
    """Runs a command; raises with the tail of stderr on failure."""
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        tail = "\n".join((p.stderr or p.stdout).strip().splitlines()[-15:])
        raise RuntimeError(f"{cmd[0]} завершился с ошибкой {p.returncode}:\n{tail}")
    if not quiet and p.stdout:
        print(p.stdout)
    return p.stdout


@dataclass
class Probe:
    duration_ms: int
    width: int | None
    height: int | None
    vcodec: str | None
    has_audio: bool
    size: int


def probe(path: str | os.PathLike) -> Probe:
    out = run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    )
    info = json.loads(out)
    v = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    a = next((s for s in info["streams"] if s.get("codec_type") == "audio"), None)
    dur = float(info["format"].get("duration") or (v or a or {}).get("duration") or 0)
    return Probe(
        duration_ms=int(round(dur * 1000)),
        width=int(v["width"]) if v else None,
        height=int(v["height"]) if v else None,
        vcodec=v.get("codec_name") if v else None,
        has_audio=a is not None,
        size=Path(path).stat().st_size,
    )


def fmt_ms(ms: float) -> str:
    s = max(0.0, ms) / 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{sec:06.3f}" if h else f"{int(m):02d}:{sec:06.3f}"


def parse_time(s: str | float | int | None) -> int | None:
    """'1:23.5', '83.5', '01:02:03' or seconds → ms; empty → None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(round(float(s) * 1000))
    s = str(s).strip().replace(",", ".")
    if not s:
        return None
    total = 0.0
    for part in s.split(":"):
        total = total * 60 + float(part or 0)
    return int(round(total * 1000))


_TRANSLIT = dict(
    zip(
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
        "a b v g d e e zh z i y k l m n o p r s t u f h c ch sh sch _ y _ e yu ya".split(),
    )
)


def slugify(s: str) -> str:
    out = "".join(_TRANSLIT.get(c, c) for c in s.lower()).replace("_", "")
    out = re.sub(r"[^a-z0-9]+", "-", out).strip("-")
    return out[:60].strip("-") or "clip"


def new_clip_id(rng: random.Random | None = None) -> str:
    r = rng or random.SystemRandom()
    return "c_" + "".join(r.choice(string.ascii_lowercase + string.digits) for _ in range(12))


def srt_time(ms: int) -> str:
    h, rem = divmod(int(ms), 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms_ = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms_:03d}"


# ---------------------------------------------------------------------------------------------
# 1. Source
# ---------------------------------------------------------------------------------------------


@dataclass
class SourceInfo:
    path: Path
    title: str = ""
    uploader: str = ""
    url: str = ""
    license: str = ""


def fetch_source(src: str, workdir: str | os.PathLike, log: Log = _log) -> SourceInfo:
    """A URL (YouTube, VK Video, Rutube, … — anything yt-dlp supports) or a local/Drive path."""
    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    src = src.strip()
    if re.match(r"^https?://", src):
        import yt_dlp  # noqa: PLC0415

        opts = {
            # ≤1080p is plenty: the game plays 720p at most
            "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
            "merge_output_format": "mp4",
            "outtmpl": str(work / "download.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "overwrites": True,
        }
        log(f"⬇ Скачиваю {src}")
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(src, download=True)
            path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
            if not path.exists():  # merged into another container
                path = next(work.glob("download.*"))
        return SourceInfo(
            path=path,
            title=info.get("title") or "",
            uploader=info.get("uploader") or info.get("channel") or "",
            url=info.get("webpage_url") or src,
            license=info.get("license") or "",
        )
    path = Path(src).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"нет файла {path}")
    return SourceInfo(path=path, title=path.stem)


def prepare_video(
    src: Path,
    out: Path,
    trim_start_ms: int | None = None,
    trim_end_ms: int | None = None,
    max_height: int = 1080,
    log: Log = _log,
) -> Probe:
    """Trims (frame-accurate) and makes an upload-friendly MP4 (H.264/AAC, ≤ 2 GB)."""
    p = probe(src)
    if not p.height:
        raise ValueError("в файле нет видео")
    if not p.has_audio:
        raise ValueError("в файле нет звука — нечего озвучивать")
    start = max(0, trim_start_ms or 0)
    end = min(p.duration_ms, trim_end_ms or p.duration_ms)
    if end - start < MIN_DURATION_MS:
        raise ValueError(f"после обрезки остаётся {fmt_ms(end - start)} — нужно хотя бы 5 с")
    dur = end - start
    trimmed = start > 0 or end < p.duration_ms
    out.parent.mkdir(parents=True, exist_ok=True)
    fits = p.size * dur / max(1, p.duration_ms) < MAX_SOURCE_BYTES
    if not trimmed and fits and p.vcodec in ("h264", "hevc", "vp9", "av1") and p.height <= max_height:
        log("✓ Видео подходит без перекодирования")
        run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0",
             "-c", "copy", "-movflags", "+faststart", str(out)])  # fmt: skip
        return probe(out)
    # bitrate that keeps the file under the upload limit
    kbps = int((MAX_SOURCE_BYTES * 8 / (dur / 1000)) / 1000) - 256
    rate = ["-crf", "20"] if kbps > 12_000 else ["-b:v", f"{max(300, kbps)}k", "-maxrate", f"{max(300, kbps)}k", "-bufsize", f"{2 * max(300, kbps)}k"]
    log(f"✂ Готовлю видео {fmt_ms(start)}–{fmt_ms(end)} ({fmt_ms(dur)})…")
    run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{start / 1000:.3f}", "-i", str(src),
         "-t", f"{dur / 1000:.3f}", "-map", "0:v:0", "-map", "0:a:0",
         "-vf", f"scale=-2:'min({max_height},ih)'", "-c:v", "libx264", "-preset", "veryfast",
         *rate, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
         "-movflags", "+faststart", str(out)]  # fmt: skip
    )
    return probe(out)


def cache_path(audio: Path, suffix: str) -> Path:
    """Derived files live in a hidden .cache folder next to the source, outside the package."""
    d = audio.parent / ".cache"
    d.mkdir(exist_ok=True)
    return d / f"{audio.stem}{suffix}"


def extract_audio(video: Path, out: Path, rate: int = 44_100, channels: int = 2) -> Path:
    run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vn", "-ac", str(channels),
         "-ar", str(rate), "-c:a", "pcm_s16le", str(out)])  # fmt: skip
    return out


# ---------------------------------------------------------------------------------------------
# 2. Voice / background separation (Demucs, processed in blocks so hour-long clips fit in RAM)
# ---------------------------------------------------------------------------------------------


def separate(
    video: Path,
    out_dir: Path,
    model_name: str = "htdemucs",
    device: str | None = None,
    block_s: int = 300,
    log: Log = _log,
) -> tuple[Path, Path]:
    """Returns (bed.flac, dialogue.flac): everything but the voice, and the voice."""
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from demucs.apply import apply_model  # noqa: PLC0415
    from demucs.pretrained import get_model  # noqa: PLC0415

    out_dir.mkdir(parents=True, exist_ok=True)
    bed_path, voice_path = out_dir / "bed.flac", out_dir / "dialogue.flac"
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    wav = extract_audio(video, cache_path(video, ".master.wav"), rate=44_100, channels=2)

    model = get_model(model_name)
    model.to(device).eval()
    sr = model.samplerate
    vi = model.sources.index("vocals")
    info = sf.info(str(wav))
    total = info.frames
    ctx = 5 * sr  # context on both sides of a block keeps the seams clean
    block = block_s * sr
    log(f"🎚 Отделяю голос от фона ({model_name}, {device}), {fmt_ms(total / sr * 1000)}…")
    t0 = time.time()
    with sf.SoundFile(str(bed_path), "w", sr, 2, subtype="PCM_16", format="FLAC") as bed_f, \
         sf.SoundFile(str(voice_path), "w", sr, 2, subtype="PCM_16", format="FLAC") as voice_f:  # fmt: skip
        for b0 in range(0, total, block):
            b1 = min(total, b0 + block)
            r0, r1 = max(0, b0 - ctx), min(total, b1 + ctx)
            x, _ = sf.read(str(wav), start=r0, stop=r1, dtype="float32", always_2d=True)
            x = torch.from_numpy(x.T.copy())
            ref = x.mean(0)
            mean, std = ref.mean(), ref.std() + 1e-8
            with torch.no_grad():
                y = apply_model(model, ((x - mean) / std)[None], device=device, split=True,
                                overlap=0.25, progress=False)[0]  # fmt: skip
            y = y * std + mean
            voice = y[vi]
            bed = y.sum(0) - voice
            a, b = b0 - r0, b0 - r0 + (b1 - b0)
            voice_f.write(np.clip(voice[:, a:b].T.cpu().numpy(), -1, 1))
            bed_f.write(np.clip(bed[:, a:b].T.cpu().numpy(), -1, 1))
            log(f"   {b1 / total:5.0%}  ({time.time() - t0:.0f} с)")
    wav.unlink(missing_ok=True)
    if device == "cuda":
        del model
        torch.cuda.empty_cache()
    return bed_path, voice_path


# ---------------------------------------------------------------------------------------------
# 3. Speech recognition → lines
# ---------------------------------------------------------------------------------------------


@dataclass
class Word:
    start: int
    end: int
    text: str
    prob: float = 1.0


@dataclass
class Segment:
    start: int
    end: int
    text: str
    words: list[Word] = field(default_factory=list)


def transcribe(
    audio: Path,
    language: str | None = None,
    model_size: str = "large-v3",
    device: str | None = None,
    translate: bool = False,
    log: Log = _log,
) -> tuple[list[Segment], str]:
    """faster-whisper with word timestamps and VAD; returns segments and the detected language."""
    from faster_whisper import WhisperModel  # noqa: PLC0415

    try:
        import torch  # noqa: PLC0415

        cuda = torch.cuda.is_available()
    except ImportError:
        cuda = False
    device = device or ("cuda" if cuda else "cpu")
    compute = "float16" if device == "cuda" else "int8"
    log(f"📝 Распознаю речь (whisper {model_size}, {device})…")
    model = WhisperModel(model_size, device=device, compute_type=compute)
    mono = cache_path(audio, ".16k.wav")
    extract_audio(audio, mono, rate=16_000, channels=1)
    segs, info = model.transcribe(
        str(mono),
        language=language or None,
        task="translate" if translate else "transcribe",
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    out: list[Segment] = []
    last = time.time()
    for s in segs:
        words = [
            Word(int(w.start * 1000), int(w.end * 1000), w.word, float(w.probability))
            for w in (s.words or [])
        ]
        out.append(Segment(int(s.start * 1000), int(s.end * 1000), s.text.strip(), words))
        if time.time() - last > 15:
            log(f"   … {fmt_ms(s.end * 1000)} из {fmt_ms(info.duration * 1000)}")
            last = time.time()
    lang = "en" if translate else info.language
    log(f"   ✓ {len(out)} фраз, язык: {lang}")
    return out, lang


def _is_hallucination(text: str) -> bool:
    t = text.strip().lower()
    return any(re.search(p, t) for p in HALLUCINATIONS)


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.!?…:;])", r"\1", text)
    if len(text) > TEXT_MAX:
        text = text[: TEXT_MAX - 1].rstrip() + "…"
    return text


@dataclass
class Line:
    start: int
    end: int
    text: str
    role: str = "r1"
    hint: str | None = None


def build_lines(
    segments: list[Segment],
    duration_ms: int,
    max_line_ms: int = 6_500,
    max_chars: int = 90,
    pause_ms: int = 700,
    min_prob: float = 0.25,
) -> list[Line]:
    """Words → readable lines: break at pauses, sentence ends and length limits; pad a little so the
    line covers the whole utterance; never overlap (lines of one role may not overlap)."""
    lines: list[Line] = []
    for seg in segments:
        if seg.text.strip() and _is_hallucination(seg.text):
            continue
        words = [w for w in seg.words if w.text.strip()] or [Word(seg.start, seg.end, seg.text)]
        cur: list[Word] = []

        def flush() -> None:
            if not cur:
                return
            text = _clean("".join(w.text for w in cur))
            probs = [w.prob for w in cur]
            if text and not _is_hallucination(text) and sum(probs) / len(probs) >= min_prob:
                lines.append(Line(cur[0].start, cur[-1].end, text))
            cur.clear()

        for w in words:
            if cur:
                gap = w.start - cur[-1].end
                dur = w.end - cur[0].start
                chars = len("".join(x.text for x in cur)) + len(w.text)
                sentence_end = re.search(r"[.!?…]$", cur[-1].text.strip()) is not None
                if (
                    gap > pause_ms
                    or dur > max_line_ms
                    or chars > max_chars
                    or (sentence_end and cur[-1].end - cur[0].start > 2_500)
                ):
                    flush()
            cur.append(w)
        flush()

    lines.sort(key=lambda l: l.start)
    # pad, keep a small gap to the next line, respect clip bounds and the minimal length
    for i, l in enumerate(lines):
        prev_end = lines[i - 1].end + 40 if i else 0
        nxt = lines[i + 1].start - 40 if i + 1 < len(lines) else duration_ms
        l.start = max(prev_end, l.start - 80, 0)
        l.end = min(max(l.end + 180, l.start + MIN_LINE_MS), nxt, duration_ms)
    return [l for l in lines if l.end - l.start >= MIN_LINE_MS]


# ---------------------------------------------------------------------------------------------
# 4. Speakers → roles
# ---------------------------------------------------------------------------------------------


def _load_mono16k(audio: Path):
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    mono = cache_path(audio, ".16k.wav")
    if not mono.exists():
        extract_audio(audio, mono, rate=16_000, channels=1)
    x, sr = sf.read(str(mono), dtype="float32")
    return np.asarray(x), sr


def _embeddings_ecapa(x, sr: int, spans: list[tuple[int, int]], log: Log):
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415

    try:
        from speechbrain.inference.speaker import EncoderClassifier  # noqa: PLC0415
    except ImportError:  # speechbrain < 1.0
        from speechbrain.pretrained import EncoderClassifier  # noqa: PLC0415
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(Path.home() / ".cache" / "dubroom-ecapa"),
        run_opts={"device": device},
    )
    out = []
    for a, b in spans:
        chunk = torch.from_numpy(x[int(a * sr / 1000) : int(b * sr / 1000)].copy())[None]
        with torch.no_grad():
            e = enc.encode_batch(chunk.to(device)).squeeze().cpu().numpy()
        out.append(e / (np.linalg.norm(e) + 1e-9))
    return np.stack(out)


def _embeddings_mfcc(x, sr: int, spans: list[tuple[int, int]]):
    """Fallback voice fingerprint without neural models: MFCC mean/std."""
    import librosa  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    out = []
    for a, b in spans:
        seg = x[int(a * sr / 1000) : int(b * sr / 1000)]
        m = librosa.feature.mfcc(y=seg, sr=sr, n_mfcc=20)
        v = np.concatenate([m.mean(1)[1:], m.std(1)[1:]])
        out.append(v)
    v = np.stack(out)
    v = (v - v.mean(0)) / (v.std(0) + 1e-9)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


def cluster_speakers(emb, n_speakers: int = 0, max_roles: int = MAX_ROLES, threshold: float = 0.62):
    """Agglomerative clustering of unit embeddings (cosine). n_speakers=0 → automatic count."""
    import numpy as np  # noqa: PLC0415
    from sklearn.cluster import AgglomerativeClustering  # noqa: PLC0415

    n = len(emb)
    if n == 0:
        return np.zeros(0, dtype=int)
    if n == 1:
        return np.zeros(1, dtype=int)

    def fit(**kw):
        try:
            return AgglomerativeClustering(metric="cosine", linkage="average", **kw).fit_predict(emb)
        except TypeError:  # scikit-learn < 1.2
            return AgglomerativeClustering(affinity="cosine", linkage="average", **kw).fit_predict(emb)

    if n_speakers > 0:
        return fit(n_clusters=min(n_speakers, max_roles, n))
    labels = fit(n_clusters=None, distance_threshold=threshold)
    if len(set(labels)) > max_roles:
        labels = fit(n_clusters=max_roles)
    return labels


def assign_roles(
    lines: list[Line],
    audio: Path,
    method: str = "ecapa",
    n_speakers: int = 0,
    max_roles: int = 4,
    hf_token: str | None = None,
    log: Log = _log,
) -> list[Line]:
    """Sets line.role (r1…rN, numbered by first appearance)."""
    import numpy as np  # noqa: PLC0415

    max_roles = max(1, min(MAX_ROLES, max_roles))
    if not lines:
        return lines
    if method == "none" or max_roles == 1 or n_speakers == 1:
        for l in lines:
            l.role = "r1"
        return lines

    labels: list[int]
    if method == "pyannote":
        labels = _pyannote_labels(lines, audio, n_speakers, max_roles, hf_token, log)
    else:
        x, sr = _load_mono16k(audio)
        # short lines give noisy fingerprints: cluster the long ones, attach the rest to centroids
        spans = []
        for l in lines:
            a, b = l.start, l.end
            if b - a < 1000:
                mid = (a + b) // 2
                a, b = max(0, mid - 500), mid + 500
            spans.append((a, b))
        log(f"🗣 Определяю голоса ({method}) для {len(lines)} реплик…")
        # cosine-distance thresholds differ: ECAPA same-speaker ≈ 0.3–0.5, MFCC statistics ≈ 0.5–0.9
        threshold = 0.6
        try:
            if method != "ecapa":
                raise RuntimeError("mfcc")
            emb = _embeddings_ecapa(x, sr, spans, log)
        except Exception as e:  # noqa: BLE001
            if method == "ecapa":
                log(f"   ⚠ ECAPA недоступна ({type(e).__name__}: {e}); использую MFCC")
            emb = _embeddings_mfcc(x, sr, spans)
            threshold = 1.0
        long_idx = [i for i, l in enumerate(lines) if l.end - l.start >= 1200] or list(range(len(lines)))
        sub = cluster_speakers(emb[long_idx], n_speakers, max_roles, threshold)
        cents = np.stack([emb[long_idx][sub == k].mean(0) for k in sorted(set(sub))])
        cents /= np.linalg.norm(cents, axis=1, keepdims=True) + 1e-9
        labels = list((emb @ cents.T).argmax(1))
        for j, i in enumerate(long_idx):
            labels[i] = int(sub[j])
        labels = _merge_tiny(labels, lines, emb, cents)

    order: dict[int, int] = {}
    for lab in labels:
        order.setdefault(lab, len(order) + 1)
    for l, lab in zip(lines, labels):
        l.role = f"r{order[lab]}"
    stats = {}
    for l in lines:
        stats[l.role] = stats.get(l.role, 0) + (l.end - l.start)
    log("   ✓ " + ", ".join(f"{r}: {v / 1000:.0f} с" for r, v in sorted(stats.items())))
    return lines


def _merge_tiny(labels, lines, emb, cents, min_lines: int = 2, min_ms: int = 2500):
    """A 'speaker' with one short line is usually noise — attach it to the nearest real one."""
    import numpy as np  # noqa: PLC0415

    labels = list(labels)
    for _ in range(MAX_ROLES):
        count: dict[int, tuple[int, int]] = {}
        for lab, l in zip(labels, lines):
            c, ms = count.get(lab, (0, 0))
            count[lab] = (c + 1, ms + l.end - l.start)
        tiny = [k for k, (c, ms) in count.items() if c < min_lines and ms < min_ms]
        big = [k for k in count if k not in tiny]
        if not tiny or not big:
            break
        k = tiny[0]
        sims = {b: float(cents[k] @ cents[b]) for b in big if b < len(cents)}
        if not sims:
            break
        target = max(sims, key=sims.get)
        labels = [target if x == k else x for x in labels]
    return labels


def _pyannote_labels(lines, audio, n_speakers, max_roles, hf_token, log) -> list[int]:
    import torch  # noqa: PLC0415
    from pyannote.audio import Pipeline  # noqa: PLC0415

    if not hf_token:
        raise ValueError("для pyannote нужен токен Hugging Face (HF_TOKEN)")
    log("🗣 Диаризация pyannote…")
    pipe = None
    for name, kw in (
        ("pyannote/speaker-diarization-community-1", {"token": hf_token}),
        ("pyannote/speaker-diarization-3.1", {"use_auth_token": hf_token}),
    ):
        try:
            pipe = Pipeline.from_pretrained(name, **kw)
            if pipe is not None:
                break
        except Exception as e:  # noqa: BLE001
            log(f"   {name}: {type(e).__name__}: {e}")
    if pipe is None:
        raise RuntimeError("не удалось загрузить pyannote: примите условия моделей на huggingface.co")
    if torch.cuda.is_available():
        pipe.to(torch.device("cuda"))
    x, sr = _load_mono16k(audio)
    kw = {"num_speakers": n_speakers} if n_speakers else {"min_speakers": 1, "max_speakers": max_roles}
    res = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr}, **kw)
    ann = getattr(res, "speaker_diarization", res)
    turns = [(int(t.start * 1000), int(t.end * 1000), spk) for t, _, spk in ann.itertracks(yield_label=True)]
    speakers = sorted({s for _, _, s in turns})
    # the most talkative speakers become roles; the rest go to the nearest turn's role
    talk = {s: sum(b - a for a, b, x in turns if x == s) for s in speakers}
    keep = sorted(speakers, key=lambda s: -talk[s])[:max_roles]
    idx = {s: i for i, s in enumerate(keep)}
    labels = []
    for l in lines:
        ov = {s: 0 for s in keep}
        for a, b, s in turns:
            if s in ov:
                ov[s] += max(0, min(b, l.end) - max(a, l.start))
        best = max(ov, key=ov.get) if ov else None
        if best is None or ov[best] == 0:
            near = min(turns, key=lambda t: abs((t[0] + t[1]) / 2 - (l.start + l.end) / 2), default=None)
            best = near[2] if near and near[2] in idx else keep[0]
        labels.append(idx[best])
    return labels


# ---------------------------------------------------------------------------------------------
# 5. Scenes (ADR-0009) — at pauses, preferably at shot cuts and on the 2 s keyframe grid
# ---------------------------------------------------------------------------------------------


def detect_shots(video: Path, threshold: float = 27.0, log: Log = _log) -> list[int]:
    """Shot boundaries (ms) with PySceneDetect; [] if it is not installed."""
    try:
        from scenedetect import ContentDetector, detect  # noqa: PLC0415
    except ImportError:
        log("   ⚠ scenedetect не установлен — сцены только по паузам")
        return []
    log("🎬 Ищу склейки кадров…")
    scenes = detect(str(video), ContentDetector(threshold=threshold), show_progress=False)
    cuts = [int(s[0].get_seconds() * 1000) for s in scenes[1:]]
    log(f"   ✓ склеек: {len(cuts)}")
    return cuts


def auto_scenes(
    lines: list[Line],
    duration_ms: int,
    shots: Iterable[int] = (),
    target_ms: int = SCENE_TARGET_MS,
    min_ms: int = SCENE_MIN_MS,
    max_ms: int = SCENE_MAX_MS,
) -> list[dict]:
    """Same rules as autoScenes() in packages/clip-format/src/scenes.ts, plus a bonus for cutting at
    a shot change inside a pause (a scene then starts on a new shot)."""
    if duration_ms <= max_ms:
        return [{"id": "s1", "startMs": 0, "endMs": duration_ms}]
    blocks: list[list[int]] = []
    for l in sorted(lines, key=lambda x: x.start):
        if blocks and l.start <= blocks[-1][1]:
            blocks[-1][1] = max(blocks[-1][1], l.end)
        else:
            blocks.append([l.start, l.end])
    shots = sorted(shots)
    cuts: list[tuple[int, int, float]] = []  # (at, gap, bonus)

    def pause(a: int, b: int) -> None:
        gap = b - a
        if gap <= 0:
            return
        g = math.ceil((a + min(400, gap / 2)) / GRID_MS) * GRID_MS
        if g <= b:
            cuts.append((g, gap, 0.15))
        else:
            cuts.append((round((a + b) / 2), gap, 0.0))
        for s in shots:
            if a + 150 <= s <= b - 150:
                cuts.append((s, gap, 0.3 + (0.15 if s % GRID_MS == 0 else 0)))

    if not blocks:
        t = target_ms
        while t < duration_ms:
            near = [s for s in shots if abs(s - t) < 8000]
            at = min(near, key=lambda s: abs(s - t)) if near else t
            cuts.append((at, 0, 0.3 if near else 0))
            t += target_ms
    else:
        pause(0, blocks[0][0])
        for i in range(1, len(blocks)):
            pause(blocks[i - 1][1], blocks[i][0])
        pause(blocks[-1][1], duration_ms)

    scenes: list[dict] = []
    start = 0
    while start < duration_ms:
        if duration_ms - start <= max_ms:
            scenes.append({"id": f"s{len(scenes) + 1}", "startMs": start, "endMs": duration_ms})
            break
        window = [c for c in cuts if start + min_ms <= c[0] <= start + max_ms and c[0] < duration_ms]
        if window:
            def score(c):  # noqa: E306
                return min(c[1], 3000) / 3000 - abs(c[0] - start - target_ms) / max_ms + c[2]

            cut = max(window, key=score)
        else:
            cut = next((c for c in cuts if start + max_ms < c[0] < duration_ms), None)
        if cut is None:
            scenes.append({"id": f"s{len(scenes) + 1}", "startMs": start, "endMs": duration_ms})
            break
        end = duration_ms if duration_ms - cut[0] < min_ms else cut[0]
        scenes.append({"id": f"s{len(scenes) + 1}", "startMs": start, "endMs": end})
        start = end
    return scenes


# ---------------------------------------------------------------------------------------------
# 6. Manifest, checks, package
# ---------------------------------------------------------------------------------------------


def build_manifest(
    *,
    title: str,
    duration_ms: int,
    lines: list[Line],
    language: str,
    credit: str,
    license: str,
    age_rating: str = "12+",
    tags: list[str] | None = None,
    role_names: list[str] | None = None,
    scenes: list[dict] | None = None,
    description: str = "",
    slug: str | None = None,
    clip_id: str | None = None,
    has_bed: bool = True,
    has_dialogue: bool = True,
) -> dict:
    lang = "en" if language == "en" else "ru"
    title_key = "ru" if re.search(r"[а-яё]", title.lower()) else lang
    role_ids = sorted({l.role for l in lines} or {"r1"}, key=lambda r: int(r[1:]))
    names = [n.strip() for n in (role_names or []) if n.strip()]
    roles = [
        {
            "id": rid,
            "name": {lang: names[i] if i < len(names) else ("Голос" if lang == "ru" else "Voice") + f" {i + 1}"},
            "color": ROLE_COLORS[i % len(ROLE_COLORS)],
        }
        for i, rid in enumerate(role_ids)
    ]
    m: dict = {
        "schema": MANIFEST_SCHEMA,
        "id": clip_id or new_clip_id(),
        "slug": slug or slugify(title),
        "version": 1,
        "title": {title_key: title[:TEXT_MAX]},
        "durationMs": int(duration_ms),
        "ageRating": age_rating,
        "tags": [t.strip()[:30] for t in (tags or []) if t.strip()][:10],
        "credit": credit,
        "license": license,
        "roles": roles,
        "lines": [
            {
                "id": f"l{i + 1}",
                "role": l.role,
                "startMs": int(l.start),
                "endMs": int(l.end),
                "text": {lang: l.text},
                **({"hint": l.hint[:60]} if l.hint else {}),
            }
            for i, l in enumerate(sorted(lines, key=lambda x: x.start))
        ],
        "source": {
            "video": "source/original.mp4",
            **({"bed": "source/bed.flac"} if has_bed else {}),
            **({"dialogue": "source/dialogue.flac"} if has_dialogue else {}),
        },
        "sync": {"leadInMs": 3000, "videoAudioOffsetMs": 0},
    }
    if description:
        m["description"] = {lang: description[:TEXT_MAX]}
    if scenes and len(scenes) > 1:
        m["scenes"] = scenes
    return m


def validate(m: dict, max_duration_ms: int = MAX_DURATION_MS) -> tuple[list[str], list[str]]:
    """The checks of validateManifest() (packages/clip-format/src/validate.ts) that matter here."""
    errors: list[str] = []
    warnings: list[str] = []
    if m.get("schema") != MANIFEST_SCHEMA:
        errors.append("schema: неверная версия манифеста")
    if not re.fullmatch(r"c_[a-z0-9]{6,32}", m.get("id", "")):
        errors.append("id: должен выглядеть как c_xxxxxx")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", m.get("slug", "")):
        errors.append("slug: только латиница, цифры и дефисы")
    if not any((v or "").strip() for v in m.get("title", {}).values()):
        errors.append("title: укажите название")
    d = m.get("durationMs", 0)
    if not MIN_DURATION_MS <= d <= max_duration_ms:
        errors.append(f"durationMs: длина {fmt_ms(d)} вне 5 с … {fmt_ms(max_duration_ms)}")
    elif d < 10_000:
        warnings.append("клип короче 10 с — игрокам почти нечего озвучить")
    if m.get("ageRating") not in AGE_RATINGS:
        errors.append("ageRating: 0+, 12+ или 16+")
    if not m.get("credit", "").strip():
        errors.append("credit: укажите источник")
    lic = m.get("license", "").strip()
    if not lic:
        errors.append("license: укажите лицензию")
    elif lic not in KNOWN_LICENSES:
        warnings.append(f"нестандартная лицензия «{lic}» — модератор проверит права вручную")
    roles = m.get("roles", [])
    if not 1 <= len(roles) <= MAX_ROLES:
        errors.append("roles: от 1 до 6 ролей")
    role_ids = {r["id"] for r in roles}
    for r in roles:
        if not re.fullmatch(r"r\d{1,2}", r["id"]):
            errors.append(f"роль {r['id']}: id вида r1")
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", r.get("color", "")):
            errors.append(f"роль {r['id']}: цвет #RRGGBB")
    lines = m.get("lines", [])
    if not lines:
        errors.append("lines: нужна хотя бы одна реплика")
    for l in lines:
        if l["role"] not in role_ids:
            errors.append(f"реплика {l['id']}: неизвестная роль {l['role']}")
        if l["endMs"] <= l["startMs"]:
            errors.append(f"реплика {l['id']}: конец раньше начала")
        elif l["endMs"] - l["startMs"] < MIN_LINE_MS:
            warnings.append(f"реплика {l['id']} короче 0.3 с")
        if l["endMs"] > d:
            errors.append(f"реплика {l['id']} выходит за конец клипа")
        if not any((v or "").strip() for v in l["text"].values()):
            errors.append(f"реплика {l['id']}: пустой текст")
        if any(len(v or "") > TEXT_MAX for v in l["text"].values()):
            errors.append(f"реплика {l['id']}: текст длиннее {TEXT_MAX} символов")
    for rid in role_ids:
        own = sorted((l for l in lines if l["role"] == rid), key=lambda l: l["startMs"])
        for a, b in zip(own, own[1:]):
            if b["startMs"] < a["endMs"]:
                errors.append(f"реплики {a['id']} и {b['id']} роли {rid} пересекаются")
        if not own:
            warnings.append(f"у роли {rid} нет реплик")
    scenes = sorted(m.get("scenes") or [], key=lambda s: s["startMs"])
    for i, s in enumerate(scenes):
        ln = s["endMs"] - s["startMs"]
        if s["endMs"] > d:
            errors.append(f"сцена {s['id']} выходит за конец клипа")
        if not SCENE_MIN_MS <= ln <= SCENE_MAX_MS:
            errors.append(f"сцена {s['id']}: {fmt_ms(ln)} — нужно от 5 с до 2 мин")
        if i and s["startMs"] < scenes[i - 1]["endMs"]:
            errors.append(f"сцены {scenes[i - 1]['id']} и {s['id']} перекрываются")
        for l in lines:
            if l["startMs"] < s["startMs"] < l["endMs"] or l["startMs"] < s["endMs"] < l["endMs"]:
                errors.append(f"граница сцены {s['id']} режет реплику {l['id']}")
        if not any(l["startMs"] >= s["startMs"] and l["endMs"] <= s["endMs"] for l in lines):
            warnings.append(f"в сцене {s['id']} нет реплик")
    if not scenes and d > SCENE_AUTO_ABOVE_MS:
        warnings.append("длинный клип без сцен — сервер разобьёт его на сцены автоматически")
    return errors, warnings


def to_srt(m: dict) -> str:
    """Cues with "[r1] " role tags — Clip Studio (step «Реплики» → «Импорт SRT») and
    `dubroom-clip lines --from-srt` read them back."""
    out = []
    for i, l in enumerate(sorted(m["lines"], key=lambda x: x["startMs"]), 1):
        text = next(v for v in l["text"].values() if v)
        hint = f" ({l['hint']})" if l.get("hint") else ""
        out.append(f"{i}\n{srt_time(l['startMs'])} --> {srt_time(l['endMs'])}\n[{l['role']}] {text}{hint}\n")
    return "\n".join(out)


def from_srt(text: str) -> list[Line]:
    """Reads an edited subtitles.srt back ("[r2] text (hint)")."""
    lines = []
    for block in re.split(r"\n\s*\n", text.replace("\r", "").strip()):
        rows = block.strip().split("\n")
        tl = next((i for i, r in enumerate(rows) if "-->" in r), None)
        if tl is None:
            continue
        a, b = (parse_time(t.strip().replace(",", ".")) for t in rows[tl].split("-->"))
        body = " ".join(rows[tl + 1 :]).strip()
        role = "r1"
        mt = re.match(r"^\[(r\d{1,2})\]\s*", body)
        if mt:
            role, body = mt.group(1), body[mt.end() :]
        hint = None
        mh = re.search(r"\s*\(([^)]{1,60})\)\s*$", body)
        if mh:
            hint, body = mh.group(1), body[: mh.start()]
        if body.strip():
            lines.append(Line(a or 0, b or 0, _clean(body), role, hint))
    return lines


def write_package(pkg: Path, m: dict, video: Path, bed: Path | None, dialogue: Path | None) -> Path:
    src = pkg / "source"
    src.mkdir(parents=True, exist_ok=True)
    for f, name in ((video, "original.mp4"), (bed, "bed.flac"), (dialogue, "dialogue.flac")):
        if f and Path(f).resolve() != (src / name).resolve():
            shutil.copyfile(f, src / name)
    (pkg / "manifest.json").write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (pkg / "subtitles.srt").write_text(to_srt(m), "utf-8")
    return pkg


def package_files(pkg: Path) -> list[Path]:
    m = json.loads((pkg / "manifest.json").read_text("utf-8"))
    files = [pkg / "manifest.json", pkg / "subtitles.srt"]
    files += [pkg / v for k, v in (m.get("source") or {}).items() if isinstance(v, str)]
    return [f for f in files if f.exists()]


def zip_package(pkg: Path, out: Path | None = None) -> Path:
    out = out or pkg.with_suffix(".zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:  # media is already compressed
        for f in package_files(pkg):
            z.write(f, f.relative_to(pkg.parent))
    return out


# ---------------------------------------------------------------------------------------------
# 7. Preview — the clip as a player would see it: background only, coloured role subtitles
# ---------------------------------------------------------------------------------------------


def _ass_color(hex_: str) -> str:
    r, g, b = hex_[1:3], hex_[3:5], hex_[5:7]
    return f"&H00{b}{g}{r}".upper()


def render_preview(
    pkg: Path,
    out: Path,
    start_ms: int = 0,
    length_ms: int = 60_000,
    audio: str = "bed",
    height: int = 360,
) -> Path:
    """audio: 'bed' (as in the game, without voices), 'dialogue' (separated voice) or 'original'."""
    m = json.loads((pkg / "manifest.json").read_text("utf-8"))
    video = pkg / "source" / "original.mp4"
    end_ms = min(m["durationMs"], start_ms + length_ms)
    names = {r["id"]: next(iter(r["name"].values())) for r in m["roles"]}
    colors = {r["id"]: r["color"] for r in m["roles"]}
    ev = []
    for l in m["lines"]:
        if l["endMs"] <= start_ms or l["startMs"] >= end_ms:
            continue
        a = max(0, l["startMs"] - start_ms)
        b = min(end_ms, l["endMs"]) - start_ms
        text = next(v for v in l["text"].values() if v).replace("\n", " ")
        t = lambda ms: f"{int(ms // 3600000)}:{int(ms // 60000 % 60):02d}:{ms / 1000 % 60:05.2f}"  # noqa: E731
        ev.append(
            f"Dialogue: 0,{t(a)},{t(b)},Default,,0,0,0,,{{\\c{_ass_color(colors[l['role']])}}}"
            f"{names[l['role']]}: {{\\c&H00FFFFFF}}{text}"
        )
    ass = out.with_suffix(".ass")
    ass.write_text(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        "Style: Default,DejaVu Sans,18,&H00FFFFFF,&H00000000,&H80000000,1,1,2,0,2,20,20,18\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        + "\n".join(ev)
        + "\n",
        "utf-8",
    )
    ss, t = f"{start_ms / 1000:.3f}", f"{(end_ms - start_ms) / 1000:.3f}"
    a_src = {"bed": pkg / "source" / "bed.flac", "dialogue": pkg / "source" / "dialogue.flac"}.get(audio)
    inputs = ["-ss", ss, "-t", t, "-i", str(video)]
    amap = "0:a:0"
    if a_src and a_src.exists():
        inputs += ["-ss", ss, "-t", t, "-i", str(a_src)]
        amap = "1:a:0"
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-map", "0:v:0", "-map", amap,
         "-vf", f"scale=-2:{height},subtitles={ass.as_posix()}", "-c:v", "libx264",
         "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-shortest",
         "-movflags", "+faststart", str(out)])  # fmt: skip
    return out


# ---------------------------------------------------------------------------------------------
# 8. Upload to Clip Studio (same endpoints as the Studio UI and `dubroom-clip publish`)
# ---------------------------------------------------------------------------------------------


class Studio:
    """Clip Studio API client. Behind Cloudflare Access, pass a service token (Zero Trust →
    Access → Service Auth) and allow it in the Studio application's policy."""

    def __init__(self, base: str, key: str, cf_client_id: str = "", cf_client_secret: str = ""):
        import requests  # noqa: PLC0415

        self.base = base.rstrip("/")
        self.s = requests.Session()
        self.s.headers["authorization"] = f"Bearer {key}"
        if cf_client_id and cf_client_secret:
            self.s.headers["CF-Access-Client-Id"] = cf_client_id
            self.s.headers["CF-Access-Client-Secret"] = cf_client_secret

    def call(self, method: str, path: str, **kw):
        for attempt in range(5):
            try:
                r = self.s.request(method, f"{self.base}/api/studio{path}", timeout=300, **kw)
            except Exception:  # network hiccup: retry with backoff
                if attempt == 4:
                    raise
                time.sleep(2 ** (attempt + 1))
                continue
            if r.status_code >= 500 and attempt < 4:
                time.sleep(2 ** (attempt + 1))
                continue
            if "text/html" in r.headers.get("content-type", "") and r.status_code in (200, 302, 403):
                raise RuntimeError(
                    "ответил не API, а страница входа — Studio закрыта Cloudflare Access: "
                    "укажите service token (CF_ACCESS_CLIENT_ID/SECRET)"
                )
            try:
                body = r.json() if r.text else {}
            except ValueError:
                body = {"error": r.text[:200]}
            if not r.ok:
                raise StudioError(r.status_code, body)
            return body
        raise RuntimeError("unreachable")

    def upload(self, draft_id: str, kind: str, path: Path, proxy: bool, log: Log = _log) -> None:
        size = path.stat().st_size
        got = self.call("GET", f"/drafts/{draft_id}/files/{kind}").get("received", 0)
        offset = got if 0 < got <= size else 0
        with open(path, "rb") as f:
            while offset < size:
                f.seek(offset)
                chunk = f.read(CHUNK_BYTES)
                q = {"offset": offset, "total": size, "name": path.name}
                if not proxy:
                    q["proxy"] = "0"
                try:
                    r = self.call(
                        "PUT",
                        f"/drafts/{draft_id}/files/{kind}",
                        params=q,
                        data=chunk,
                        headers={"content-type": "application/octet-stream"},
                    )
                    offset = r["received"]
                except StudioError as e:
                    if e.status == 409 and isinstance(e.body.get("received"), int):
                        offset = e.body["received"]  # server has a different amount: resume there
                        continue
                    raise
                log(f"   ⬆ {kind}: {offset / size:5.0%}")


class StudioError(RuntimeError):
    def __init__(self, status: int, body: dict):
        self.status, self.body = status, body
        issues = "; ".join(i.get("message", "") for i in body.get("issues", []) or [])
        super().__init__(f"HTTP {status}: {body.get('message') or body.get('error') or ''} {issues}".strip())


def publish(
    pkg: Path,
    api: str,
    key: str,
    mode: str = "submit",
    cf_client_id: str = "",
    cf_client_secret: str = "",
    log: Log = _log,
) -> dict:
    """mode: 'draft' — upload and finish in Clip Studio; 'submit' — send to processing and
    moderation; 'approve' — also publish right away (only for trusted content you own)."""
    m = json.loads((pkg / "manifest.json").read_text("utf-8"))
    st = Studio(api, key, cf_client_id, cf_client_secret)
    st.call("GET", "/me")
    draft = st.call("POST", "/drafts", json={"manifest": m})
    did = draft["draftId"]
    log(f"✓ Черновик {did}")
    files = {k: pkg / v for k, v in (m.get("source") or {}).items() if k in ("video", "bed", "dialogue")}
    for kind, path in files.items():
        if path.exists():
            st.upload(did, kind, path, proxy=(mode == "draft"), log=log)
    result = {"draftId": did, "clipId": m["id"], "status": "draft"}
    if mode == "draft":
        log(f"✓ Загружено. Проверьте и отправьте черновик в Clip Studio: {st.base}/#/draft/{did}")
        return result
    st.call("POST", f"/drafts/{did}/submit")
    log("⚙ Отправлено на обработку, жду сервер…")
    last = -1.0
    while True:
        time.sleep(5)
        d = st.call("GET", f"/drafts/{did}")["draft"]
        if d["status"] == "failed":
            raise RuntimeError("обработка не удалась: " + "; ".join(e["message"] for e in d.get("errors", [])))
        if d["status"] == "done":
            for w in d.get("warnings", []):
                log(f"   ⚠ {w['message']}")
            result.update(status="review", version=d["version"])
            break
        if d.get("progress", 0) - last >= 0.1:
            last = d.get("progress", 0)
            log(f"   {last:5.0%}")
    if mode == "approve":
        st.call("POST", f"/clips/{m['id']}/versions/{result['version']}/publish")
        result["status"] = "published"
        log("✓ Опубликован — клип уже в игре")
    else:
        log("✓ Обработан и ждёт модерации в Clip Studio → «Библиотека»")
    return result


# ---------------------------------------------------------------------------------------------
# Whole pipeline
# ---------------------------------------------------------------------------------------------


@dataclass
class Config:
    source: str
    title: str = ""
    credit: str = ""
    license: str = "Own work"
    age_rating: str = "12+"
    tags: str = ""
    trim_start: str = ""
    trim_end: str = ""
    separation: str = "htdemucs"  # htdemucs | htdemucs_ft | none
    language: str = ""  # "" = auto, ru, en, …
    translate_to_english: bool = False
    whisper_model: str = "large-v3"
    diarization: str = "ecapa"  # ecapa | pyannote | mfcc | none
    speakers: int = 0  # 0 = auto
    max_roles: int = 4
    role_names: str = ""
    hf_token: str = ""
    scenes: bool = True
    shot_detection: bool = True
    workdir: str = "/content/dubroom"


def make_clip(cfg: Config, log: Log = _log) -> tuple[Path, dict, list[str], list[str]]:
    """Runs everything; stages are cached in the work folder, so a re-run after a change of,
    e.g., the number of speakers does not separate and transcribe again."""
    work = Path(cfg.workdir)
    info = fetch_source(cfg.source, work / "download", log)
    title = cfg.title.strip() or info.title or "Новый клип"
    slug = slugify(title)
    pkg = work / slug
    src = pkg / "source"
    src.mkdir(parents=True, exist_ok=True)
    stamp = json.dumps([cfg.source, cfg.trim_start, cfg.trim_end])
    cache = pkg / ".stage.json"
    state = json.loads(cache.read_text()) if cache.exists() else {}
    if state.get("stamp") != stamp:
        state = {"stamp": stamp}
    video = src / "original.mp4"
    if not state.get("video") or not video.exists():
        prepare_video(info.path, video, parse_time(cfg.trim_start), parse_time(cfg.trim_end), log=log)
        state = {"stamp": stamp, "video": True}
        cache.write_text(json.dumps(state))
    p = probe(video)
    log(f"✓ Видео: {fmt_ms(p.duration_ms)}, {p.height}p, {p.size / 1e6:.0f} МБ")

    bed = src / "bed.flac"
    dialogue = src / "dialogue.flac"
    if cfg.separation != "none":
        if state.get("sep") != cfg.separation or not bed.exists():
            separate(video, src, cfg.separation, log=log)
            state["sep"] = cfg.separation
            state.pop("asr", None)
            cache.write_text(json.dumps(state))
        voice_for_asr = dialogue
    else:
        bed.unlink(missing_ok=True)
        dialogue.unlink(missing_ok=True)
        voice_for_asr = extract_audio(video, cache_path(video, ".audio.wav"))

    asr_key = [cfg.separation, cfg.language, cfg.whisper_model, cfg.translate_to_english]
    asr_file = pkg / ".asr.json"
    if state.get("asr") == asr_key and asr_file.exists():
        raw = json.loads(asr_file.read_text("utf-8"))
        segs = [Segment(s["start"], s["end"], s["text"], [Word(**w) for w in s["words"]]) for s in raw["segments"]]
        lang = raw["language"]
    else:
        segs, lang = transcribe(voice_for_asr, cfg.language or None, cfg.whisper_model,
                                translate=cfg.translate_to_english, log=log)  # fmt: skip
        asr_file.write_text(
            json.dumps(
                {"language": lang, "segments": [
                    {"start": s.start, "end": s.end, "text": s.text,
                     "words": [w.__dict__ for w in s.words]} for s in segs]},  # fmt: skip
                ensure_ascii=False,
            ),
            "utf-8",
        )
        state["asr"] = asr_key
        cache.write_text(json.dumps(state))

    lines = build_lines(segs, p.duration_ms)
    log(f"✓ Реплик: {len(lines)}")
    assign_roles(lines, voice_for_asr, cfg.diarization, cfg.speakers, cfg.max_roles, cfg.hf_token, log)

    scenes = None
    if cfg.scenes and p.duration_ms > SCENE_AUTO_ABOVE_MS:
        shots = []
        if cfg.shot_detection:
            if "shots" in state:
                shots = state["shots"]
            else:
                shots = detect_shots(video, log=log)
                state["shots"] = shots
                cache.write_text(json.dumps(state))
        scenes = auto_scenes(lines, p.duration_ms, shots)
        log(f"✓ Сцен: {len(scenes)} (" + ", ".join(f"{(s['endMs'] - s['startMs']) / 1000:.0f} с" for s in scenes) + ")")

    credit = cfg.credit.strip() or " — ".join(x for x in (info.uploader, info.url) if x)
    m = build_manifest(
        title=title,
        duration_ms=p.duration_ms,
        lines=lines,
        language=lang,
        credit=credit,
        license=cfg.license,
        age_rating=cfg.age_rating,
        tags=cfg.tags.split(","),
        role_names=cfg.role_names.split(","),
        scenes=scenes,
        slug=slug,
        clip_id=state.get("clip_id"),
        has_bed=cfg.separation != "none",
        has_dialogue=cfg.separation != "none",
    )
    state["clip_id"] = m["id"]  # the same clip keeps its id across re-runs
    cache.write_text(json.dumps(state))
    write_package(pkg, m, video, bed if bed.exists() else None, dialogue if dialogue.exists() else None)
    errors, warnings = validate(m)
    if (p.height or 0) < 480:
        errors.append(f"разрешение исходника {p.height}p, сервер принимает от 480p — возьмите версию качественнее")
    return pkg, m, errors, warnings


def reload_srt(pkg: Path, srt_text: str, role_names: list[str] | None = None) -> tuple[dict, list[str], list[str]]:
    """Applies an edited subtitles.srt to the package manifest (roles, times, text, hints)."""
    m = json.loads((pkg / "manifest.json").read_text("utf-8"))
    lang = next(iter(m["lines"][0]["text"])) if m["lines"] else "ru"
    lines = from_srt(srt_text)
    old_names = [next(iter(r["name"].values())) for r in m["roles"]]
    new = build_manifest(
        title=next(iter(m["title"].values())),
        duration_ms=m["durationMs"],
        lines=lines,
        language=lang,
        credit=m["credit"],
        license=m["license"],
        age_rating=m["ageRating"],
        tags=m["tags"],
        role_names=role_names or old_names,
        scenes=auto_scenes(lines, m["durationMs"]) if m.get("scenes") else None,
        slug=m["slug"],
        clip_id=m["id"],
        has_bed="bed" in m["source"],
        has_dialogue="dialogue" in m["source"],
    )
    if m.get("scenes") and not any(
        l.start < s["startMs"] < l.end for s in m["scenes"] for l in lines
    ):
        new["scenes"] = m["scenes"]  # keep hand-made scenes while they still fit
    (pkg / "manifest.json").write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (pkg / "subtitles.srt").write_text(to_srt(new), "utf-8")
    e, w = validate(new)
    return new, e, w
