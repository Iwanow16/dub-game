"""Unit tests for the Colab clip factory (no models, no network): pytest tools/colab"""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import dubroom_factory as f  # noqa: E402


def seg(start, end, text, words=None):
    ws = words
    if ws is None:
        parts = text.split()
        d = (end - start) / len(parts)
        ws = [f.Word(int(start + i * d), int(start + (i + 1) * d), " " + w) for i, w in enumerate(parts)]
    return f.Segment(start, end, text, ws)


def test_time_helpers():
    assert f.parse_time("1:23.5") == 83_500
    assert f.parse_time("01:02:03") == 3_723_000
    assert f.parse_time("2,5") == 2_500
    assert f.parse_time("") is None
    assert f.srt_time(3_723_045) == "01:02:03,045"
    assert f.fmt_ms(83_500) == "01:23.500"


def test_slug_and_id():
    assert f.slugify("Где все? Тест фабрики!") == "gde-vse-test-fabriki"
    assert f.slugify("Объявление") == "obyavlenie"
    assert f.slugify("???") == "clip"
    assert len(f.new_clip_id()) == 14


def test_lines_split_at_pauses_sentences_and_length():
    words = [
        f.Word(0, 400, " Привет."),
        f.Word(450, 900, " Как"),
        f.Word(950, 1300, " дела?"),
        f.Word(2500, 2900, " Нормально."),  # pause > 700 ms → new line
    ]
    lines = f.build_lines([f.Segment(0, 2900, "", words)], 10_000)
    assert [l.text for l in lines] == ["Привет. Как дела?", "Нормально."]
    # a long monologue is split into lines of at most ~6.5 s
    long_words = [f.Word(i * 400, i * 400 + 350, f" слово{i}") for i in range(60)]
    lines = f.build_lines([f.Segment(0, 24_000, "", long_words)], 30_000)
    assert len(lines) >= 4
    assert all(l.end - l.start <= 7_000 for l in lines)


def test_lines_drop_hallucinations_and_never_overlap():
    segs = [
        seg(1000, 3000, "Где мои ключи?"),
        seg(3100, 3500, "Продолжение следует..."),
        seg(3050, 5000, "Опять потерял."),
    ]
    lines = f.build_lines(segs, 6000)
    assert [l.text for l in lines] == ["Где мои ключи?", "Опять потерял."]
    for a, b in zip(lines, lines[1:]):
        assert a.end <= b.start
    assert lines[-1].end <= 6000


def test_cluster_speakers_auto_and_fixed():
    rng = np.random.default_rng(1)
    a = rng.normal([1, 0, 0], 0.05, (6, 3))
    b = rng.normal([0, 1, 0], 0.05, (6, 3))
    emb = np.vstack([a, b])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    auto = f.cluster_speakers(emb, 0, 4)
    assert len(set(auto)) == 2 and len(set(auto[:6])) == 1 and len(set(auto[6:])) == 1
    assert len(set(f.cluster_speakers(emb, 3, 4))) == 3
    assert len(set(f.cluster_speakers(emb, 0, 1))) == 1


def test_roles_none_method():
    lines = [f.Line(0, 1000, "a", "r3"), f.Line(1200, 2000, "b", "r2")]
    f.assign_roles(lines, Path("/nonexistent"), "none")
    assert {l.role for l in lines} == {"r1"}


def test_auto_scenes_prefer_shot_cuts_in_pauses():
    # a line every 5 s, 3 s long: pauses 3–5, 8–10, …; a shot change inside one pause near 44 s
    lines = [f.Line(t, t + 3000, "x") for t in range(0, 300_000, 5000)]
    scenes = f.auto_scenes(lines, 300_000, shots=[43_500])
    assert scenes[0]["endMs"] == 43_500
    for s in scenes:
        assert f.SCENE_MIN_MS <= s["endMs"] - s["startMs"] <= f.SCENE_MAX_MS
        assert not any(l.start < s["endMs"] < l.end for l in lines)
    assert scenes[-1]["endMs"] == 300_000
    assert f.auto_scenes(lines[:10], 60_000) == [{"id": "s1", "startMs": 0, "endMs": 60_000}]


def manifest(**kw):
    lines = [f.Line(1000, 2500, "Привет!", "r1"), f.Line(3000, 4200, "Здравствуй.", "r2")]
    base = dict(
        title="Тест",
        duration_ms=12_000,
        lines=lines,
        language="ru",
        credit="автор",
        license="CC0 1.0",
        role_names=["Кот", "Пёс"],
    )
    base.update(kw)
    return f.build_manifest(**base)


def test_manifest_is_valid_and_matches_schema_shape():
    m = manifest()
    errors, warnings = f.validate(m)
    assert errors == [] and warnings == []
    assert m["roles"][1] == {"id": "r2", "name": {"ru": "Пёс"}, "color": "#3DA5FF"}
    assert m["lines"][0]["text"] == {"ru": "Привет!"}
    assert m["source"] == {"video": "source/original.mp4", "bed": "source/bed.flac", "dialogue": "source/dialogue.flac"}
    en = manifest(language="en", title="Test", role_names=[])
    assert en["title"] == {"en": "Test"} and en["roles"][0]["name"] == {"en": "Voice 1"}


def test_validation_catches_mistakes():
    m = manifest(license="", credit="")
    m["lines"][1]["role"] = "r1"
    m["lines"][1]["startMs"] = 2000  # overlaps l1 of the same role
    m["scenes"] = [{"id": "s1", "startMs": 0, "endMs": 2000}, {"id": "s2", "startMs": 2000, "endMs": 12_000}]
    errors, _ = f.validate(m)
    text = " ".join(errors)
    for part in ("credit", "license", "пересекаются", "режет реплику", "нужно от 5 с"):
        assert part in text, part


def test_srt_roundtrip_keeps_roles_and_hints():
    m = manifest()
    m["lines"][0]["hint"] = "весело"
    srt = f.to_srt(m)
    assert "[r2] Здравствуй." in srt and "(весело)" in srt
    back = f.from_srt(srt)
    assert [(l.start, l.end, l.role, l.text, l.hint) for l in back] == [
        (1000, 2500, "r1", "Привет!", "весело"),
        (3000, 4200, "r2", "Здравствуй.", None),
    ]


def test_package_files_and_reload(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"0")
    m = manifest(has_bed=False, has_dialogue=False)
    pkg = f.write_package(tmp_path / "clip", m, video, None, None)
    assert sorted(p.name for p in f.package_files(pkg)) == ["manifest.json", "original.mp4", "subtitles.srt"]
    srt = (pkg / "subtitles.srt").read_text().replace("[r2] Здравствуй.", "[r1] Здравствуй, друг.")
    new, errors, _ = f.reload_srt(pkg, srt)
    assert errors == []
    assert new["id"] == m["id"] and [r["id"] for r in new["roles"]] == ["r1"]
    assert json.loads((pkg / "manifest.json").read_text())["lines"][1]["text"]["ru"] == "Здравствуй, друг."


class FakeResponse:
    def __init__(self, status, body, ctype="application/json"):
        self.status_code, self._body = status, body
        self.ok = status < 400
        self.headers = {"content-type": ctype}
        self.text = json.dumps(body) if isinstance(body, dict) else body

    def json(self):
        return json.loads(self.text)


def test_upload_resumes_after_offset_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(f, "CHUNK_BYTES", 4)
    data = tmp_path / "bed.flac"
    data.write_bytes(b"0123456789")
    calls = []

    def request(method, url, **kw):
        calls.append((method, url.split("/api/studio")[1], kw.get("params")))
        if method == "GET":
            return FakeResponse(200, {"received": 0, "size": None})
        off = kw["params"]["offset"]
        if off == 4 and not any(c[2] and c[2]["offset"] == 6 for c in calls):
            return FakeResponse(409, {"error": "offset_mismatch", "received": 6})
        return FakeResponse(200, {"received": off + len(kw["data"])})

    st = f.Studio("https://studio.example", "k", "cid", "secret")
    monkeypatch.setattr(st.s, "request", request)
    st.upload("d1", "bed", data, proxy=False, log=lambda m: None)
    offsets = [c[2]["offset"] for c in calls if c[0] == "PUT"]
    assert offsets == [0, 4, 6]
    assert all(c[2]["proxy"] == "0" for c in calls if c[0] == "PUT")
    assert st.s.headers["CF-Access-Client-Id"] == "cid"


def test_access_login_page_is_reported(monkeypatch):
    st = f.Studio("https://studio.example", "k")
    monkeypatch.setattr(st.s, "request", lambda *a, **k: FakeResponse(200, "<html>login</html>", "text/html"))
    with pytest.raises(RuntimeError, match="Cloudflare Access"):
        st.call("GET", "/me")
