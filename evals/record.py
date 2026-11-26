"""Record the eval clips: shows each line from clips.yaml, records 16 kHz mono 16-bit WAV.

    uv run python -m evals.record              # record every clip that doesn't exist yet
    uv run python -m evals.record --only M03   # just these ids or categories (comma-separated)
    uv run python -m evals.record --redo       # re-record existing clips too
"""

import argparse
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd
import yaml

HERE = Path(__file__).parent
CLIPS_DIR = HERE / "clips"
SAMPLE_RATE = 16000


def record_until_enter() -> np.ndarray:
    chunks: list[np.ndarray] = []
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                        callback=lambda data, *_: chunks.append(data.copy())):
        input("  ● recording… press Enter to stop ")
    return np.concatenate(chunks)[:, 0] if chunks else np.zeros(0, np.int16)


def save_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.tobytes())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated clip ids or categories")
    ap.add_argument("--redo", action="store_true")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None

    clips = yaml.safe_load(open(HERE / "clips.yaml"))
    CLIPS_DIR.mkdir(exist_ok=True)
    todo = [c for c in clips
            if (only is None or c["id"] in only or c["category"] in only)
            and (args.redo or not (CLIPS_DIR / f"{c['id']}.wav").exists())]
    print(f"{len(todo)} clips to record. Wait ~1 s after starting and before stopping.\n")

    for i, c in enumerate(todo, 1):
        while True:
            print(f"[{i}/{len(todo)}] {c['id']}:  {c['text']}")
            if c["category"] == "M":
                print(f"  say it WRONG on purpose, exactly as written (correct: {c['correct']})")
            if c.get("pause"):
                print("  pause ~1–1.5 s where you see '...'")
            input("  press Enter to start ")
            samples = record_until_enter()
            save_wav(CLIPS_DIR / f"{c['id']}.wav", samples)
            print(f"  saved {len(samples) / SAMPLE_RATE:.1f} s")
            choice = input("  [r]etake / [n]ext / [q]uit: ").strip().lower()
            if choice == "q":
                return
            if choice != "r":
                print()
                break


if __name__ == "__main__":
    main()
