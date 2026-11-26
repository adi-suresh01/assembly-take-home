import pytest
import yaml

from agent import format_turn_line, make_stt


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
