"""Scoring for the STT eval. Pure functions, no I/O."""

import re
import unicodedata
from collections import defaultdict

import jiwer
import numpy as np

EDGE_S = 0.05  # tolerance when comparing end-of-turn times with the end of speech


def _clean(text: str, accents: bool = False) -> str:
    text = text.lower()
    if not accents:
        text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    text = unicodedata.normalize("NFC", text)
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


def normalize(text: str) -> str:
    """Lowercase, strip accents and punctuation (incl. ¿ ¡ ...), collapse spaces."""
    return _clean(text)


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = normalize(reference), normalize(hypothesis)
    if not hyp:
        return 1.0 if ref else 0.0
    return float(jiwer.wer(ref, hyp))


def _has_phrase(phrase: str, text: str) -> bool:
    return f" {phrase} " in f" {text} "


def term_accuracy(terms: list[str], hypothesis: str, accents: bool = False) -> float | None:
    """Fraction of Spanish terms found as whole words in the transcript."""
    if not terms:
        return None
    hyp = _clean(hypothesis, accents)
    return sum(_has_phrase(_clean(t, accents), hyp) for t in terms) / len(terms)


def mistake_kept(error_word: str, hypothesis: str) -> bool:
    """True if the learner's wrong word survived into the transcript (wasn't auto-'fixed')."""
    return _has_phrase(normalize(error_word), normalize(hypothesis))


def speech_end_s(samples: np.ndarray, sample_rate: int) -> float:
    """End of the last stretch of speech: at least 60 ms (3 frames of 20 ms) louder than both
    30 dB below the loudest frame and 10 dB above the room noise (the quietest 20% of frames).
    The 60 ms minimum skips short clicks, like the Enter key that stops the recording."""
    frame, min_run = int(sample_rate * 0.02), 3
    n = len(samples) // frame
    if n == 0:
        return 0.0
    frames = samples[: n * frame].astype(np.float64).reshape(n, frame)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    if rms.max() == 0:
        return 0.0
    threshold = max(rms.max() * 10 ** (-30 / 20), np.percentile(rms, 20) * 10 ** (10 / 20))
    loud = rms > threshold
    if not loud.any():  # silence or steady noise: no speech to end
        return 0.0
    runs = np.nonzero(np.convolve(loud, np.ones(min_run), "valid") == min_run)[0]
    last = runs[-1] + min_run - 1 if len(runs) else np.nonzero(loud)[0][-1]
    return float((last + 1) * frame / sample_rate)


def cutoffs(eot_times: list[float], speech_end: float) -> int:
    """End-of-turn events that fired before the speaker had finished."""
    return sum(t < speech_end - EDGE_S for t in eot_times)


def latency_ms(eot_times: list[float], speech_end: float) -> float | None:
    """Time from end of speech to the first end-of-turn after it; None if none arrived."""
    after = [t for t in eot_times if t >= speech_end - EDGE_S]
    return (after[0] - speech_end) * 1000 if after else None


def _mean(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return round(float(np.mean(vals)), 4) if vals else None


def summarize(rows: list[dict]) -> dict[str, dict]:
    """Aggregate per-(clip, provider) rows into one summary per provider."""
    by_provider: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_provider[r["provider"]].append(r)

    out = {}
    for provider, prs in by_provider.items():
        ok = [r for r in prs if not r["error"]]
        m_rows = [r for r in ok if r["category"] == "M"]
        h_rows = [r for r in ok if r["category"] == "H"]
        lats = [r["latency_ms"] for r in ok if r["latency_ms"] is not None]
        out[provider] = {
            "clips": len(prs),
            "wer": _mean([r["wer"] for r in ok]),
            "wer_by_category": {cat: _mean([r["wer"] for r in ok if r["category"] == cat])
                                for cat in dict.fromkeys(r["category"] for r in ok)},
            "term_acc": _mean([r["term_acc"] for r in ok]),
            "term_acc_accents": _mean([r["term_acc_accents"] for r in ok]),
            "mistakes_kept": f"{sum(bool(r['mistake_kept']) for r in m_rows)}/{len(m_rows)}",
            "cutoff_clips": f"{sum(r['cutoffs'] > 0 for r in h_rows)}/{len(h_rows)}",
            "latency_p50_ms": round(float(np.percentile(lats, 50)), 1) if lats else None,
            "latency_p90_ms": round(float(np.percentile(lats, 90)), 1) if lats else None,
            "no_eot": sum(r["latency_ms"] is None for r in ok),
            "errors": len(prs) - len(ok),
        }
    return out
