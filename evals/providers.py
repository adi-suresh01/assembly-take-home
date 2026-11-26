"""Streaming STT clients for the eval: play a clip at real-time pace over each provider's
WebSocket and record when each end-of-turn arrives.

Both clients use the same settings the agent uses (config.yaml) and follow the same pattern:
send audio in fixed chunks paced to the wall clock, then trailing silence, then the
provider's close message, and record (seconds since first audio, transcript) per turn.
"""

import asyncio
import json
import os
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode

import numpy as np
import websockets


@dataclass
class StreamResult:
    provider: str
    turns: list[tuple[float, str]] = field(default_factory=list)
    error: str | None = None

    @property
    def text(self) -> str:
        return " ".join(t for _, t in self.turns).strip()


def read_pcm16(path: Path, sample_rate: int = 16000) -> np.ndarray:
    with wave.open(str(path)) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, sample_rate):
            raise ValueError(f"{path}: need 16 kHz mono 16-bit")
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


async def _stream(provider, url, headers, samples, chunk_ms, sample_rate, trailing_s, close_msg, parse):
    """parse(msg) -> (kind, text, key): kind is "eot", "done", "error" or None; key dedupes a turn."""
    result = StreamResult(provider)
    audio = np.concatenate([samples, np.zeros(int(trailing_s * sample_rate), np.int16)]).tobytes()
    step = int(sample_rate * chunk_ms / 1000) * 2  # bytes per chunk (16-bit)
    turns: dict = {}  # key -> [time of first end-of-turn, latest text]
    t0 = None

    async def send(ws):
        nonlocal t0
        t0 = time.monotonic()
        for i, offset in enumerate(range(0, len(audio), step)):
            await ws.send(audio[offset:offset + step])
            delay = t0 + (i + 1) * chunk_ms / 1000 - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
        await ws.send(json.dumps(close_msg))

    async def receive(ws):
        async for raw in ws:
            if isinstance(raw, bytes):
                continue
            kind, text, key = parse(json.loads(raw))
            if kind == "error":
                raise RuntimeError(text)
            if kind == "eot" and t0 is not None:
                turns.setdefault(key, [time.monotonic() - t0, text])[1] = text
            if kind == "done":
                return

    try:
        async with asyncio.timeout(len(audio) / (2 * sample_rate) + 10):
            async with websockets.connect(url, additional_headers=headers) as ws:
                async with asyncio.TaskGroup() as tg:
                    tg.create_task(send(ws))
                    tg.create_task(receive(ws))
    except* Exception as eg:  # never raise: record the error and let the run continue
        result.error = repr(eg.exceptions[0])
    result.turns = [(t, text) for t, text in turns.values()]
    return result


def _parse_assemblyai(msg: dict):
    kind = msg.get("type")
    if kind == "Turn" and msg.get("end_of_turn"):
        return "eot", msg.get("transcript", ""), msg.get("turn_order")
    if kind == "Termination":
        return "done", "", None
    if kind == "Error" or "error" in msg:
        return "error", json.dumps(msg), None
    return None, "", None


def _parse_deepgram(msg: dict):
    kind = msg.get("type")
    if kind == "TurnInfo" and msg.get("event") == "EndOfTurn":
        return "eot", msg.get("transcript", ""), msg.get("turn_index")
    if kind == "Error":
        return "error", json.dumps(msg), None
    return None, "", None


async def stream_assemblyai(samples, cfg: dict, languages: list[str], *, sample_rate=16000, trailing_s=2.0):
    # Same query parameters the LiveKit plugin sends for this config (see config.yaml).
    query = {
        "sample_rate": sample_rate,
        "encoding": "pcm_s16le",
        "speech_model": cfg["model"],
        "min_turn_silence": cfg["min_turn_silence"],
        "max_turn_silence": cfg["max_turn_silence"],
        "language_detection": "true",
        "language_codes": json.dumps(languages),
        "previous_context_n_turns": cfg["previous_context_n_turns"],
    }
    url = "wss://streaming.assemblyai.com/v3/ws?" + urlencode(query)
    headers = {"Authorization": os.environ.get("ASSEMBLYAI_API_KEY", "")}
    return await _stream("assemblyai", url, headers, samples, cfg["chunk_ms"], sample_rate, trailing_s,
                         {"type": "Terminate"}, _parse_assemblyai)


async def stream_deepgram(samples, cfg: dict, languages: list[str], *, sample_rate=16000, trailing_s=2.0):
    query = [("model", cfg["model"]), ("encoding", "linear16"), ("sample_rate", sample_rate)]
    query += [("language_hint", lang) for lang in languages]
    url = "wss://api.deepgram.com/v2/listen?" + urlencode(query)
    headers = {"Authorization": f"Token {os.environ.get('DEEPGRAM_API_KEY', '')}"}
    return await _stream("deepgram", url, headers, samples, cfg["chunk_ms"], sample_rate, trailing_s,
                         {"type": "CloseStream"}, _parse_deepgram)


STREAMERS = {"assemblyai": stream_assemblyai, "deepgram": stream_deepgram}
