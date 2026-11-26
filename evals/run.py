"""Run the STT eval: stream every recorded clip through each provider and score it.

    uv run python -m evals.run                         # all clips, both providers
    uv run python -m evals.run --only M,H01 --verbose  # some ids/categories, show transcripts
    uv run python -m evals.run --providers assemblyai
"""

import argparse
import asyncio
import json
import platform
from datetime import datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

from evals.metrics import cutoffs, latency_ms, mistake_kept, speech_end_s, summarize, term_accuracy, wer
from evals.providers import STREAMERS, read_pcm16

ROOT = Path(__file__).parent.parent
CLIPS_DIR = ROOT / "evals" / "clips"
RESULTS = ROOT / "results" / "results.json"
console = Console()


def select_clips(clips: list[dict], clips_dir: Path, only: set[str] | None) -> tuple[list[dict], list[str]]:
    """Clips matching `only` (ids or categories), split into (recorded, missing ids)."""
    wanted = [c for c in clips if only is None or c["id"] in only or c["category"] in only]
    present = [c for c in wanted if (clips_dir / f"{c['id']}.wav").exists()]
    missing = [c["id"] for c in wanted if not (clips_dir / f"{c['id']}.wav").exists()]
    return present, missing


def score(clip: dict, provider: str, result, end_s: float) -> dict:
    terms = clip.get("spanish_terms", [])
    row = {"provider": provider, "id": clip["id"], "category": clip["category"], "error": result.error,
           "text": result.text, "eot_times": [round(t, 3) for t, _ in result.turns]}
    if result.error:
        return {**row, "wer": None, "term_acc": None, "term_acc_accents": None,
                "mistake_kept": None, "cutoffs": 0, "latency_ms": None}
    eots = [t for t, _ in result.turns]
    return {
        **row,
        "wer": round(wer(clip["text"], result.text), 4),
        "term_acc": term_accuracy(terms, result.text),
        "term_acc_accents": term_accuracy(terms, result.text, accents=True),
        "mistake_kept": mistake_kept(clip["error_word"], result.text) if clip["category"] == "M" else None,
        "cutoffs": cutoffs(eots, end_s),
        "latency_ms": None if (lat := latency_ms(eots, end_s)) is None else round(lat, 1),
    }


async def run(providers: list[str], only: set[str] | None, verbose: bool) -> dict:
    cfg = yaml.safe_load(open(ROOT / "config.yaml"))
    clips, missing = select_clips(yaml.safe_load(open(ROOT / "evals" / "clips.yaml")), CLIPS_DIR, only)
    if missing:
        console.print(f"[yellow]{len(missing)} clips missing (not recorded yet): {', '.join(missing)}[/]")
    rows, per_clip = [], []
    for i, clip in enumerate(clips):
        samples = read_pcm16(CLIPS_DIR / f"{clip['id']}.wav", cfg["sample_rate"])
        end_s = speech_end_s(samples, cfg["sample_rate"])
        order = providers if i % 2 == 0 else providers[::-1]  # spread network noise evenly
        results = {}
        for p in order:
            r = await STREAMERS[p](samples, cfg[p], cfg["languages"],
                                   sample_rate=cfg["sample_rate"], trailing_s=cfg["trailing_silence_s"])
            row = score(clip, p, r, end_s)
            rows.append(row)
            results[p] = {k: v for k, v in row.items() if k not in ("provider", "id", "category")}
        console.print(f"[dim]{i + 1}/{len(clips)} {clip['id']}[/] " +
                      "  ".join(f"{p}: {'ERR' if results[p]['error'] else results[p]['wer']}" for p in providers))
        if verbose:
            console.print(f"   ref: {clip['text']}")
            for p in providers:
                console.print(f"   {p}: {results[p]['text'] or results[p]['error']}")
        per_clip.append({"id": clip["id"], "category": clip["category"], "reference": clip["text"],
                         "speech_end_s": round(end_s, 3), "results": results})
    return {
        "run": {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "platform": platform.platform(), "providers": providers,
                "clips_evaluated": len(clips), "clips_missing": missing},
        "config": {"languages": cfg["languages"], "sample_rate": cfg["sample_rate"],
                   "trailing_silence_s": cfg["trailing_silence_s"], **{p: cfg[p] for p in providers}},
        "summary": summarize(rows),
        "clips": per_clip,
    }


def _pct(v):
    return "–" if v is None else f"{v:.0%}"


def print_table(summary: dict) -> None:
    t = Table(title="Speech-to-text on learner clips (lower ↓ / higher ↑ is better)")
    for col in ["Provider", "WER ↓", "Spanish terms ↑ (accent-exact)", "Mistakes kept ↑",
                "Hesitation cut-offs ↓", "Latency p50 / p90 ms ↓", "No end-of-turn", "Errors"]:
        t.add_column(col)
    for p, s in summary.items():
        t.add_row(p, _pct(s["wer"]), f"{_pct(s['term_acc'])} ({_pct(s['term_acc_accents'])})",
                  s["mistakes_kept"], s["cutoff_clips"],
                  f"{s['latency_p50_ms'] or '–'} / {s['latency_p90_ms'] or '–'}",
                  str(s["no_eot"]), str(s["errors"]))
    console.print(t)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default="assemblyai,deepgram")
    ap.add_argument("--only", help="comma-separated clip ids or categories")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    load_dotenv(ROOT / ".env")
    report = asyncio.run(run(args.providers.split(","),
                             set(args.only.split(",")) if args.only else None, args.verbose))
    print_table(report["summary"])
    RESULTS.parent.mkdir(exist_ok=True)
    RESULTS.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    console.print(f"wrote {RESULTS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
