import os
import wave
from collections import Counter
from pathlib import Path

import numpy as np
import pytest
import yaml

from agent import format_turn_line, make_stt
from evals.metrics import (
    cutoffs,
    latency_ms,
    mistake_kept,
    normalize,
    speech_end_s,
    summarize,
    term_accuracy,
    wer,
)
from evals.providers import STREAMERS, read_pcm16
from evals.run import select_clips


# --- agent helpers -----------------------------------------------------------

def test_make_stt_selects_provider(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "x")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "x")
    cfg = yaml.safe_load(open("config.yaml"))
    from livekit.plugins import assemblyai, deepgram

    assert isinstance(make_stt("assemblyai", cfg), assemblyai.STT)
    assert isinstance(make_stt("deepgram", cfg), deepgram.STTv2)
    with pytest.raises(ValueError):
        make_stt("whisper", cfg)


def test_format_turn_line():
    assert format_turn_line("assemblyai", "hola", 0.34) == '[assemblyai] heard: "hola"  end-of-turn: 340 ms'


# --- clip set ----------------------------------------------------------------

def test_clips_yaml_is_consistent():
    clips = yaml.safe_load(open("evals/clips.yaml"))
    assert len(clips) == 25 and len({c["id"] for c in clips}) == 25
    assert Counter(c["category"] for c in clips) == {"Q": 8, "A": 6, "M": 6, "H": 5}
    for c in clips:
        words = normalize(c["text"]).split()
        for term in c.get("spanish_terms", []):
            assert normalize(term) in normalize(c["text"]), (c["id"], term)
        if c["category"] == "M":
            assert normalize(c["error_word"]) in words and c["correct"]
        if c["category"] == "H":
            assert c["pause"] is True and "..." in c["text"]


# --- metrics -----------------------------------------------------------------

def test_normalize():
    assert normalize("¿Dónde está la Estación?") == "donde esta la estacion"
    assert normalize("How do you say... butterfly?") == "how do you say butterfly"


def test_wer():
    assert wer("yo soy estudiante", "Yo es estudiante.") == pytest.approx(1 / 3)


def test_term_accuracy():
    assert term_accuracy(["la estación", "mariposa"], "is it la estacion or el estación") == 0.5
    assert term_accuracy(["la estación"], "la estacion", accents=True) == 0.0
    assert term_accuracy([], "anything") is None


def test_mistake_kept_whole_word():
    assert mistake_kept("es", "Yo es estudiante.")
    assert not mistake_kept("es", "Yo soy estudiante.")  # "es" inside "estudiante" doesn't count


def test_speech_end_s():
    sr = 16000
    tone = (0.5 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr) * 32767).astype(np.int16)
    audio = np.concatenate([np.zeros(sr, np.int16), tone, np.zeros(sr, np.int16)])
    assert speech_end_s(audio, sr) == pytest.approx(2.0, abs=0.05)


def test_speech_end_s_ignores_room_noise_and_key_click():
    # Shaped like the real clips: quiet speech (~-31 dBFS), room noise ~30 dB below it,
    # then the Enter-key click that stops the recording.
    sr = 16000
    rng = np.random.default_rng(0)
    speech = 0.04 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr) * 32767
    noise = rng.normal(0, 0.0012 * 32767, sr)
    click = rng.normal(0, 0.008 * 32767, sr // 50)
    audio = np.concatenate([speech, noise, click]).astype(np.int16)
    assert speech_end_s(audio, sr) == pytest.approx(1.0, abs=0.05)


def test_cutoffs_and_latency():
    assert cutoffs([1.2, 3.4], 3.0) == 1
    assert latency_ms([1.2, 3.4], 3.0) == pytest.approx(400)


def test_latency_none_without_eot():
    assert latency_ms([], 3.0) is None
    assert latency_ms([1.0], 3.0) is None


def test_empty_hypothesis():
    assert wer("hola", "") == 1.0
    assert term_accuracy(["hola"], "") == 0.0
    assert not mistake_kept("es", "")


def test_summarize_skips_errors():
    ok = dict(provider="assemblyai", category="M", error=None, wer=0.2, term_acc=None,
              term_acc_accents=None, mistake_kept=True, cutoffs=0, latency_ms=300.0)
    no_eot = {**ok, "latency_ms": None}
    err = {**ok, "error": "401", "wer": None}
    s = summarize([ok, no_eot, err])["assemblyai"]
    assert s["errors"] == 1 and s["no_eot"] == 1
    assert s["mistakes_kept"] == "2/2" and s["latency_p50_ms"] == 300.0


# --- streaming + runner --------------------------------------------------------

def test_read_pcm16_rejects_wrong_format(tmp_path):
    p = tmp_path / "bad.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\0" * 400)
    with pytest.raises(ValueError, match="16 kHz mono"):
        read_pcm16(p)


def test_select_clips_reports_missing(tmp_path):
    (tmp_path / "Q01.wav").write_bytes(b"")
    clips = [{"id": "Q01", "category": "Q"}, {"id": "M01", "category": "M"}]
    present, missing = select_clips(clips, tmp_path, None)
    assert [c["id"] for c in present] == ["Q01"] and missing == ["M01"]
    assert select_clips(clips, tmp_path, {"M"}) == ([], ["M01"])


@pytest.mark.parametrize("provider,key", [("assemblyai", "ASSEMBLYAI_API_KEY"), ("deepgram", "DEEPGRAM_API_KEY")])
@pytest.mark.asyncio
async def test_live_stream_smoke(provider, key):
    from dotenv import load_dotenv
    load_dotenv()
    clip = Path("evals/clips/A01.wav")
    if not os.getenv(key) or not clip.exists():
        pytest.skip("needs key and recorded clip")
    cfg = yaml.safe_load(open("config.yaml"))
    r = await STREAMERS[provider](read_pcm16(clip), cfg[provider], cfg["languages"])
    assert r.error is None and r.turns and "estacion" in normalize(r.text)
