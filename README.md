# Spanish tutor voice agent on AssemblyAI

A reference voice agent for a language-learning app, plus the kit to show a customer it's worth
switching to.

**The scenario.** Learners ask how to say a word or phrase in Spanish. The tutor teaches it, the
learner tries it out loud, and the tutor gives feedback. The customer already runs this on another
voice AI provider and is evaluating AssemblyAI to replace it. The brief doesn't name the provider,
so this repo assumes Deepgram (Flux), a common choice for LiveKit voice agents.

**What's here:**
1. **A working tutor** on LiveKit, using AssemblyAI speech-to-text, Claude, and AssemblyAI text-to-speech.
2. **An eval** that plays the same 25 recorded learner clips through AssemblyAI and Deepgram and scores them on what matters for a tutor.
3. **[MIGRATION.md](MIGRATION.md)**: the one-line switch, the settings worth reviewing, and a rollout plan.

## Quickstart

Needs Python 3.13 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
cp .env.example .env        # add ASSEMBLYAI_API_KEY and ANTHROPIC_API_KEY
                            # (DEEPGRAM_API_KEY only for the comparison)

uv run python agent.py console                         # talk to the tutor (use headphones)
STT_PROVIDER=deepgram uv run python agent.py console   # same tutor, Deepgram speech-to-text

uv run python -m evals.run       # the eval: 25 clips x 2 providers x 3 passes, about 20 minutes
uv run python -m evals.record    # record your own clips (optional)
uv run pytest                    # unit tests, plus live smoke tests when keys are set
```

Each turn in the console prints what the speech-to-text heard and how long it took to decide the
learner had finished:

```
[assemblyai] heard: "<what the learner said>"  end-of-turn: <ms> ms
```

## How it's built

```
 Tutor (agent.py), inside a LiveKit AgentSession

   mic ──► AssemblyAI STT ──► Claude ──► AssemblyAI TTS ──► speaker
           (decides when        (Haiku     (Spanish voice)
            the turn ends)       5.5)

           STT_PROVIDER=deepgram swaps in Deepgram Flux; nothing else changes

 Eval (evals/)

   25 learner clips ──► AssemblyAI ─┐
   (real-time pace)  ──► Deepgram  ─┴─► metrics ──► results/results.json + table
```

| File | What it does |
|---|---|
| `agent.py` | The tutor: prompt, `make_stt()` (the one switch), per-turn line in the console |
| `config.yaml` | Speech-to-text and TTS settings shared by the agent and the eval, so what we measure is what we deploy |
| `evals/clips.yaml`, `evals/clips/` | The 25 clips: reference text, Spanish terms, deliberate mistakes |
| `evals/record.py` | Records clips at 16 kHz mono |
| `evals/providers.py` | Streams a clip to each provider's WebSocket at real-time pace, using the same parameters the LiveKit plugins send |
| `evals/metrics.py` | WER, Spanish-term accuracy, mistakes kept, cut-offs, latency |
| `evals/run.py` | Runs everything and writes `results/results.json` |
| `test_app.py` | Tests |

## Key decisions

- **LiveKit Agents, not AssemblyAI's Voice Agent API.**
  - The Voice Agent API is being retired.
  - LiveKit is where a team like this customer most likely already runs, so switching is one constructor.
- **Switch speech-to-text only.**
  - It decides whether the tutor's feedback is right: if the transcript is wrong, the correction is wrong.
  - Switching TTS is an optional second step (see MIGRATION.md).
- **No keyterm boosting and no conversation context, for either provider.**
  - Biasing the transcript toward the phrase the tutor just taught turns a learner's mistake into the right answer, so the tutor praises an error.
  - Both run raw.
- **A fair comparison.**
  - Each provider runs its published voice-agent defaults: AssemblyAI `mode: balanced`, Deepgram Flux defaults.
  - Both get the same language list (`en`, `es`) and the same audio.
  - Clips are streamed at real-time pace, in alternating order, over 3 pooled passes.
  - Nothing was tuned on the clips.
- **Claude Haiku 5.5 as the LLM.**
  - Measured with the tutor prompt: first words in 0.73 s, against 2.19 s for Opus 5.5.
  - In a voice loop, dead air costs more than the extra intelligence buys.
  - Swap it with `CLAUDE_MODEL`.
- **A Spanish TTS voice.** A TTS session speaks one language. The Spanish voice keeps the phrases learners copy native, with accented English explanations. An English voice anglicizes the Spanish.

## The eval

25 clips of one learner (me), in four groups:

| Group | Clips | Example | What it tests |
|---|---|---|---|
| Q | 8 | "Is it la estación or el estación?" | English questions with Spanish words in them |
| A | 6 | "¿Dónde está la estación de tren?" | Spanish attempts, said correctly |
| M | 6 | "Yo **es** estudiante." | Spanish attempts with a deliberate mistake |
| H | 5 | "How do you say... butterfly in Spanish?" | A pause in the middle of the sentence |

| Metric | Meaning |
|---|---|
| WER | Word error rate against the reference. Lowercase, accents and punctuation stripped. Lower is better. |
| Spanish terms | Share of the expected Spanish words and phrases that came through. The accent-exact score is in brackets. |
| Mistakes kept | M clips: did the wrong word survive? An STT that "fixes" the learner's grammar hides the error from the tutor. |
| Hesitation cut-offs | H clips: did the turn end during the pause? If so, the tutor answers half a question. |
| Latency | Time from the end of speech (measured from the audio) to the provider's end-of-turn message. p50 / p90. |

## Results

From `results/results.json`: 25 clips, 3 passes, 75 runs per provider, run on 2026-11-26.

| | WER ↓ | Spanish terms ↑ | Mistakes kept ↑ | Hesitation cut-offs ↓ | End-of-turn latency p50 / p90 ↓ | Errors |
|---|---|---|---|---|---|---|
| **AssemblyAI** | **6.3%** | **88%** (88%) | 11/17 | 3/15 | 566.7 / 1653.9 ms | 1 |
| **Deepgram** | 16.9% | 65% (65%) | 12/18 | 3/15 | **429.5 / 726.9 ms** | 0 |

**Accuracy decides this use case, and AssemblyAI wins it clearly.**
- AssemblyAI makes about a third of Deepgram's word errors.
- Learners mix English and Spanish in one sentence, and that's exactly where Deepgram breaks. When the transcript is wrong, the tutor answers the wrong question.
- Every pass gave the same transcripts:

| Learner said | AssemblyAI | Deepgram |
|---|---|---|
| What does **dónde está el baño** mean? | What does "¿Dónde está el baño?" mean? | What does donde esta **Albanio** mean? |
| **Is it** la estación or el estación? | Is it la estación or el estación? | **Isidro** la estación or el estación? |
| ¿Cuánto cuesta el **billete**? | ¿Cuánto cuesta el billete? | ¿Cuánto cuesta el **viente**? |
| Is it... **la mariposa** or **el mariposa**? | Is it La Mariposa or El Mariposa? | Is it **lamari posa** or **lmari posa**? |
| ...is it **tengo** hambre? | ...Is it tengo hambre? | ...Is it **tango** hambre? |

AssemblyAI's misses are smaller. It heard "buenas noches" as "buenos noches" on two clips; Deepgram made the same miss on one of them.

**Mistakes kept: a tie, but the two fail differently.**
- Both kept about two thirds of the deliberate mistakes.
- **AssemblyAI autocorrected two, every pass:** "el estación" came back as "la estación", and "Tengo hombre" as "Tengo hambre". It did this with no boosting and no context. For a tutor this is the worse failure, because the tutor then praises an error.
- **Deepgram garbled two:** "Yo es estudiante" came back as "US estudiant", and "Ella es cansada" as "a s cansada". Those lead to "please try again".
- This is the first thing to test on the customer's own audio, and to raise with AssemblyAI's model team.

**Latency: Deepgram is faster.**
- About 137 ms faster at the median.
- At p90, AssemblyAI takes 1.65 s against Deepgram's 0.73 s.
- **AssemblyAI's slow tail is consistent, not random.** A few turns take 1.6–2.2 s on every pass: "How do you say... butterfly in Spanish?", "Is it... la mariposa or el mariposa?", "Yo es estudiante." These are turns AssemblyAI doesn't read as finished, so it waits for the 1280 ms maximum silence of its `balanced` preset.
- AssemblyAI also had two one-off stalls that replays didn't reproduce: 9.7 s once on one clip in this run, and 6.8 s once in an earlier run.
- `mode: min_latency` (640 ms maximum silence) is the knob for this. It's untested here: it needs a rerun of both providers, tuned equally, on the customer's audio.

**Hesitation cut-offs: one clip each, on every pass.**
- AssemblyAI ended the turn at "I want to say..."
- Deepgram ended it at "Can you repeat..."

**Errors.** AssemblyAI refused one connection with "Too many concurrent sessions", even though the eval opens one session at a time. That run is left out of the scores, which is why its mistakes count is out of 17.

**About an earlier run.** A first single pass ran AssemblyAI at 100 / 1000 ms turn silence instead of its published `balanced` preset. The 100 ms came from the LiveKit plugin's override, and the 1000 ms from an outdated doc value. That broke the rule of running each provider on its published defaults, so I fixed it before this run, deciding from AssemblyAI's docs rather than from the results. In that pass AssemblyAI scored 6% WER, 94% Spanish terms, 3/5 cut-offs, and 561 / 1570 ms latency. Deepgram scored 17%, 65%, 1/5, and 412 / 770 ms.

## Limitations

- **Small sample.**
  - 25 clips, one speaker, one microphone, one room, one network.
  - The numbers point a direction; they don't prove anything.
  - The kit's real value is rerunning it on the customer's own learner audio.
- **Word-level mistakes only.** The eval checks which words came through, not pronunciation quality. The tutor says so too: it only sees a transcript.
- **Deepgram as the incumbent is an assumption.** The brief doesn't name the provider.
- **Live console numbers are anecdotal.** The eval is the measurement.
- **Scoring quirks.** WER doesn't normalize numbers, so "20 años" vs "veinte años" counts as an error.
