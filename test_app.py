from collections import Counter

import pytest
import yaml

from agent import format_turn_line, make_stt
from evals.metrics import normalize


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
