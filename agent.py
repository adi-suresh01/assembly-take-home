"""Spanish tutor voice agent: AssemblyAI speech-to-text + Claude + AssemblyAI text-to-speech, on LiveKit.

Run in the terminal:   uv run python agent.py console
Switch STT provider:   STT_PROVIDER=deepgram uv run python agent.py console
"""

import json
import os
import time
from pathlib import Path

import yaml
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    MetricsCollectedEvent,
    UserInputTranscribedEvent,
    cli,
)
from livekit.agents.metrics import EOUMetrics
from livekit.plugins import anthropic, assemblyai, deepgram, silero

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
CONFIG = yaml.safe_load(open(ROOT / "config.yaml"))
LIVE_LOG = ROOT / "results" / "live_turns.jsonl"

TUTOR_PROMPT = """\
You are Sofía, a warm, patient Spanish tutor for English speakers, talking over voice.

How you talk:
- Everything you write is spoken aloud. Use plain sentences only: no markdown, lists, emojis,
  phonetic alphabet, or parentheses.
- Keep each turn to at most three short sentences.
- Explain in English. Write Spanish words and phrases in correct Spanish, with accents.

Teaching a phrase:
1. Give the Spanish phrase.
2. Break it into two or three short chunks, each separated by a period so it is spoken slowly.
3. End with: "Now you try."

Giving feedback on an attempt:
- You only receive a transcript of what the learner said, not their audio. Compare it word by
  word with the phrase you taught.
- If a word differs, name that word and give the correct one. For example: "Close! You said
  el estación. It's la estación."
- If every word matches, say they got all the words right. Never claim their pronunciation or
  accent was perfect, because you cannot hear it.
- If the transcript is empty, garbled, or unrelated, ask them to try again.
- Then offer another phrase or ask what else they want to learn.

Answer quick questions about Spanish (meaning, grammar, ser versus estar) briefly, then return
to practice.
"""


def make_stt(provider: str, cfg: dict):
    """The one line a migration changes: which speech-to-text provider the agent listens with."""
    if provider == "assemblyai":
        c = cfg["assemblyai"]
        return assemblyai.STT(
            model=c["model"],
            min_turn_silence=c["min_turn_silence"],
            max_turn_silence=c["max_turn_silence"],
            previous_context_n_turns=c["previous_context_n_turns"],
            language_codes=cfg["languages"],
        )
    if provider == "deepgram":
        return deepgram.STTv2(model=cfg["deepgram"]["model"], language_hint=cfg["languages"])
    raise ValueError(f"unknown STT_PROVIDER {provider!r} (use 'assemblyai' or 'deepgram')")


def format_turn_line(provider: str, transcript: str, eou_delay_s: float) -> str:
    return f'[{provider}] heard: "{transcript}"  end-of-turn: {eou_delay_s * 1000:.0f} ms'


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    provider = os.getenv("STT_PROVIDER", "assemblyai")
    tts_cfg = CONFIG["tts"]
    session = AgentSession(
        stt=make_stt(provider, CONFIG),
        llm=anthropic.LLM(model=os.getenv("CLAUDE_MODEL", "claude-opus-5-5")),
        tts=assemblyai.TTS(model=tts_cfg["model"], voice=tts_cfg["voice"], language=tts_cfg["language"]),
        vad=silero.VAD.load(activation_threshold=0.3),
        # The STT decides when the learner has finished; LiveKit adds no extra delay on top.
        turn_handling={"turn_detection": "stt", "endpointing": {"min_delay": 0}},
        # Don't feed the agent's own replies to the STT as context: it would bias the transcript
        # toward the phrase just taught and hide the learner's mistakes.
        stt_context_options={"forward_chat_context": False},
    )

    heard: list[str] = []

    @session.on("user_input_transcribed")
    def _on_transcript(ev: UserInputTranscribedEvent):
        if ev.is_final:
            heard.append(ev.transcript)

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent):
        m = ev.metrics
        if not isinstance(m, EOUMetrics):
            return
        transcript = " ".join(heard).strip()
        heard.clear()
        print(format_turn_line(provider, transcript, m.end_of_utterance_delay), flush=True)
        LIVE_LOG.parent.mkdir(exist_ok=True)
        with LIVE_LOG.open("a") as f:
            f.write(json.dumps({
                "ts": time.time(),
                "provider": provider,
                "transcript": transcript,
                "eou_delay_ms": round(m.end_of_utterance_delay * 1000),
                "transcription_delay_ms": round(m.transcription_delay * 1000),
            }, ensure_ascii=False) + "\n")

    await session.start(agent=Agent(instructions=TUTOR_PROMPT), room=ctx.room)
    await session.say("Hola! What would you like to learn to say in Spanish?")


if __name__ == "__main__":
    cli.run_app(server)
