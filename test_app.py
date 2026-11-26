import json
import os
import time
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
from evals.providers import STREAMERS, assemblyai_query, read_pcm16
from evals.run import RESULTS, results_path, score, select_clips


# --- agent helpers -----------------------------------------------------------

def test_make_stt_selects_provider(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "x")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "x")
    cfg = yaml.safe_load(open("config.yaml"))
    from livekit.plugins import assemblyai, deepgram

    aai = make_stt("assemblyai", cfg)
    assert isinstance(aai, assemblyai.STT)
    # AssemblyAI's published voice-agent preset decides the silence windows, not the plugin's 100 ms.
    assert aai._opts.mode == "balanced"
    assert not isinstance(aai._opts.min_turn_silence, int)
    assert not isinstance(aai._opts.max_turn_silence, int)
    dg = make_stt("deepgram", cfg)
    assert isinstance(dg, deepgram.STTv2)
    # The agent streams audio in the same chunk sizes the eval measured.
    assert aai._opts.buffer_size_seconds == cfg["assemblyai"]["chunk_ms"] / 1000
    assert dg._opts.audio_chunk_duration_ms == cfg["deepgram"]["chunk_ms"]
    with pytest.raises(ValueError):
        make_stt("whisper", cfg)


def test_eval_assemblyai_query_uses_published_preset():
    cfg = yaml.safe_load(open("config.yaml"))
    q = assemblyai_query(cfg["assemblyai"], cfg["languages"], 16000)
    assert q["mode"] == "balanced"
    assert q["speech_model"] == "assemblyai-stt-3-7-realtime-agent"
    assert q["language_codes"] == '["en", "es"]'
    assert "min_turn_silence" not in q and "max_turn_silence" not in q


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


def test_speech_end_s_without_speech_does_not_crash():
    rng = np.random.default_rng(1)
    assert speech_end_s(np.full(16000, 5, np.int16), 16000) == 0.0
    assert speech_end_s(rng.normal(0, 30, 16000).astype(np.int16), 16000) == 0.0


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


def test_summarize_reports_wer_by_category():
    base = dict(provider="deepgram", error=None, term_acc=None, term_acc_accents=None,
                mistake_kept=None, cutoffs=0, latency_ms=300.0)
    rows = [{**base, "category": "Q", "wer": 0.2}, {**base, "category": "Q", "wer": 0.4},
            {**base, "category": "A", "wer": 0.0}]
    assert summarize(rows)["deepgram"]["wer_by_category"] == {"Q": pytest.approx(0.3), "A": 0.0}


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


def test_only_full_runs_write_results_json():
    both = ["assemblyai", "deepgram"]
    assert results_path(None, both) == RESULTS and results_path(None, both[::-1]) == RESULTS
    assert results_path({"M"}, both) is None
    assert results_path(None, ["assemblyai"]) is None


async def _fake_stream(samples, chunk_ms=50):
    """Stream to a local stand-in STT server. It logs when each audio chunk arrives and only
    sends its end-of-turn after the client's close message, like a turn the server never ended."""
    from websockets.asyncio.server import serve

    from evals.providers import _stream
    arrivals = []

    async def handler(ws):
        opened = time.monotonic()
        async for msg in ws:
            if isinstance(msg, bytes):
                arrivals.append(time.monotonic() - opened)
            else:
                await ws.send(json.dumps({"type": "eot", "text": "hola"}))
                await ws.send(json.dumps({"type": "done"}))

    def parse(m):
        return {"eot": ("eot", m.get("text"), 0), "done": ("done", "", None)}.get(m["type"], (None, "", None))

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        result = await _stream("fake", f"ws://127.0.0.1:{port}", {}, samples, chunk_ms, 16000, 0.0,
                               {"type": "close"}, parse)
    return result, arrivals


@pytest.mark.asyncio
async def test_stream_sends_each_chunk_only_after_its_audio_has_elapsed():
    _, arrivals = await _fake_stream(np.zeros(3200, np.int16))  # 0.2 s = four 50 ms chunks
    assert len(arrivals) == 4
    assert arrivals[0] >= 0.045  # a live mic can't send the first 50 ms before 50 ms have passed


@pytest.mark.asyncio
async def test_end_of_turn_after_close_is_not_scored_as_latency():
    result, _ = await _fake_stream(np.zeros(3200, np.int16))
    assert result.error is None and result.text == "hola"  # the words still count for accuracy
    row = score({"id": "X", "category": "A", "text": "hola"}, "fake", result, end_s=0.1)
    assert row["wer"] == 0.0
    assert row["latency_ms"] is None and row["cutoffs"] == 0


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
