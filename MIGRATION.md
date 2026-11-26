# Moving a LiveKit voice agent's speech-to-text to AssemblyAI

For a team whose agent already runs on LiveKit with another streaming STT (this guide assumes
Deepgram Flux). The LLM, TTS, rooms, and the rest of the agent stay as they are.

## 1. The change

```diff
- from livekit.plugins import deepgram
+ from livekit.plugins import assemblyai

- stt = deepgram.STTv2(model="flux-general-multi", language_hint=["en", "es"])
+ stt = assemblyai.STT(
+     model="assemblyai-stt-3-7-realtime-agent",
+     mode="balanced",
+     language_codes=["en", "es"],
+     previous_context_n_turns=0,
+ )
```

Plus `livekit-agents[assemblyai]` in your dependencies and `ASSEMBLYAI_API_KEY` in the environment.
`AgentSession(turn_handling={"turn_detection": "stt", ...})` works unchanged: AssemblyAI decides
when the learner has finished, as Flux did.

In this repo the switch is one environment variable, `STT_PROVIDER=assemblyai` or
`STT_PROVIDER=deepgram` (see `make_stt` in `agent.py`), so you can run both side by side.

## 2. Settings worth reviewing

| Setting | Used here | AssemblyAI default | When to change it |
|---|---|---|---|
| `mode` | `balanced` | `balanced` | `min_latency` if fast turn-taking matters more than accuracy. `max_accuracy` is meant for note-takers, not agents. |
| `min_turn_silence` / `max_turn_silence` | not set (the preset gives 128 / 1280 ms) | from `mode` | Raise `min_turn_silence` if learners get cut off mid-sentence. It can change mid-stream (`UpdateConfiguration`), so you can raise it only while the learner attempts a phrase ("Now you try") and reset `mode` afterwards. Tune it on the customer's held-out audio, not on the eval clips. |
| `language_codes` | `["en", "es"]` | auto-detect | Use the learner's native language plus the target language. One list per course. |
| Context (`agent_context`, carryover) | off: `previous_context_n_turns=0` and `AgentSession(stt_context_options={"forward_chat_context": False})` | on for this model | Keep it off for practice turns. Context biases the transcript toward what the tutor just said, which turns a learner's "el estación" into "la estación" and hides the very mistake the tutor should correct. |
| `keyterms_prompt` | off | off | Same reason as context. Use it only for turns that aren't pronunciation practice, like course names or a learner's name. |
| `vad_threshold`, `voice_focus` | defaults | `0.2`, off | Raise `vad_threshold` or turn on `voice_focus` (`near-field` for headsets, `far-field` for laptop mics) if background noise causes false interruptions. |
| LiveKit `endpointing.min_delay` | `0` | LiveKit adds 0.5 s | With `turn_detection="stt"`, LiveKit waits this long *after* the STT already ended the turn. Set it to 0 whichever STT you use. |

## 3. What doesn't map one-to-one

- **Turn events.**
  - Flux sends `StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`.
  - AssemblyAI sends `Turn` messages: partials with `end_of_turn: false`, then a final with `end_of_turn: true`.
  - LiveKit hides both behind the plugin. This only matters if your code reads raw events.
  - If you start the LLM early on `EagerEndOfTurn`, the closest equivalent is AssemblyAI's pause partials, which it emits when a pause triggers an end-of-turn check that doesn't end the turn.
- **End-of-turn controls.**
  - Flux uses a confidence threshold (`eot_threshold`, `eager_eot_threshold`) plus a timeout (`eot_timeout_ms`).
  - AssemblyAI checks whether the transcript reads as finished once `min_turn_silence` passes, and always ends the turn at `max_turn_silence`.
  - `eot_timeout_ms` roughly corresponds to `max_turn_silence`. Nothing matches the confidence threshold directly.
- **Languages.** Flux `language_hint` is a hint. AssemblyAI `language_codes` restricts language detection to the listed languages.
- **Transcript format.**
  - AssemblyAI returns cased, punctuated text with Spanish accents and `¿`.
  - It writes numbers as digits ("20 años").
  - Your prompts and any string matching should expect this.

## 4. Rollout

1. **Eval on the customer's own audio.** Put their learner clips in `evals/clips/`, list them in
   `evals/clips.yaml`, and run `uv run python -m evals.run`. Same harness, their data. Small samples
   only point a direction, so the more real learner audio, the better.
2. **Shadow mode.**
   - Run AssemblyAI on live sessions alongside the current STT. Learners only hear the current one.
   - Log both transcripts and end-of-turn times, and compare word accuracy on Spanish terms, cut-offs, and latency.
   - This repo doesn't build shadow mode. It needs a second STT stream fed the same audio.
3. **Canary.**
   - Move 5%, then 50%, then 100% of sessions, split by learner.
   - Watch end-of-turn latency (p50/p90), how often a learner's turn is cut off and continued, "please try again" rate, and how often the tutor's correction matched what the learner actually said.
4. **Rollback.** Set `STT_PROVIDER` back and restart the workers. No code change.

## 5. Optional step 2: TTS

`assemblyai.TTS(model="assemblyai-tts-1", voice="aai-antonioluis", language="es")` replaces the
current TTS in one line.

**Caveat:** a TTS session speaks one language, but a tutor's replies mix English explanations with
Spanish phrases. We rendered the same tutor reply with a Spanish voice and with an English voice:
- **The Spanish voice** keeps the Spanish native and speaks the English with an accent, the way a real Spanish tutor would.
- **The English voice** anglicizes the Spanish ("es-tay-shun"), which teaches the wrong pronunciation.

This agent uses the Spanish voice. For a product with several target languages, pick the voice per
course at session start. If accented explanations are a problem, the next step is to split each
reply by language and send each part to its own voice (not built here).

## 6. Questions for the customer

- **What fails today?** Wrong Spanish words, learners cut off mid-sentence, slow replies, or cost?
- **Learners:** which language pairs, and what are their native languages? Do they mostly use headsets, laptops, or phones?
- **Current setup:** STT model, endpointing settings, keyterms or context?
- **Latency budget:** how long from the learner stopping to the tutor speaking?
- **Scale and data:** concurrency at peak, regions (EU data residency?), recording consent, and retention.
- **Measuring quality:** do they have labeled learner audio we can evaluate on?

## 7. One vendor for STT and the LLM

AssemblyAI's LLM Gateway serves Claude, GPT, Gemini and others through one OpenAI-compatible
endpoint (`https://llm-gateway.assemblyai.com/v1`, or the EU host). A team that wants one vendor and
one bill can point LiveKit's OpenAI-compatible LLM plugin at it.

Before doing that in a voice loop, check that streaming works for the model you pick. The gateway
docs list streamed responses for OpenAI models, and a reply that isn't streamed delays the tutor's
first word until the whole reply is written.
