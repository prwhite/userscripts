#!/usr/bin/env python3
"""Batch every video in eval/corpus.md through the pipeline.

corpus.md is just a list of YouTube URLs / ids in any format (one per line, a
markdown list, plain links — whatever). This extracts the video ids and runs
each through `python -m ytdistill --save-run --save-transcript`, so each lands
in ~/.ytdistill/runs/<id>/ ready for the compare step (see rubric.md).
"""

from __future__ import annotations

import argparse
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CORPUS = HERE / "corpus.md"
CACHE_ROOT = Path(os.environ.get("YTDISTILL_HOME", str(Path.home() / ".ytdistill"))) / "cache"


def _is_cached(vid: str) -> bool:
    d = CACHE_ROOT / vid
    return (d / "meta.json").exists() and (d / "captions.vtt").exists()

_ID = r"[A-Za-z0-9_-]{11}"
_URL_ID = re.compile(r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/)(" + _ID + r")")
_BARE_ID = re.compile(r"^\s*(" + _ID + r")\s*$", re.M)


def extract_ids(text: str) -> list[str]:
    ids: list[str] = []
    for pat in (_URL_ID, _BARE_ID):
        for m in pat.finditer(text):
            if m.group(1) not in ids:
                ids.append(m.group(1))
    return ids


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run the corpus through the pipeline.")
    p.add_argument("--provider", default="openai")
    p.add_argument("--model", default=None)
    p.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    p.add_argument("--sleep", type=float, default=3.0,
                   help="pause before each real YouTube fetch (rate-limit courtesy)")
    p.add_argument("--max-attempts", type=int, default=3,
                   help="attempts per video for transient (rate-limit) failures")
    p.add_argument("--cooldown", type=float, default=20.0,
                   help="base seconds to wait after a rate-limit before retrying")
    p.add_argument("--refresh", action="store_true", help="ignore caches and re-pull/re-run")
    p.add_argument("--dry-run", action="store_true", help="list ids without running")
    args = p.parse_args(argv)

    path = Path(args.corpus)
    if not path.exists():
        print(f"no corpus file at {path}", file=sys.stderr)
        return 1
    ids = extract_ids(path.read_text(encoding="utf-8"))
    if not ids:
        print(f"no video ids found in {path}", file=sys.stderr)
        return 1

    print(f"{len(ids)} video(s): {', '.join(ids)}")
    if args.dry_run:
        return 0

    failures: list[str] = []
    for i, vid in enumerate(ids, 1):
        will_fetch = args.refresh or not _is_cached(vid)
        if i > 1 and will_fetch and args.sleep:
            time.sleep(args.sleep)  # courtesy delay only before an actual YouTube fetch
        print(f"\n[{i}/{len(ids)}] {vid} ...", flush=True)
        cmd = [sys.executable, "-m", "ytdistill", vid,
               "--provider", args.provider, "--save-run", "--save-transcript"]
        if args.model:
            cmd += ["--model", args.model]
        if args.refresh:
            cmd.append("--refresh")

        for attempt in range(1, args.max_attempts + 1):
            r = subprocess.run(cmd, capture_output=True, text=True)
            sys.stdout.write(r.stdout)
            sys.stderr.write(r.stderr)
            if r.returncode == 0:
                break
            # Retry only transient rate-limits; a genuine "no captions" is permanent.
            transient = ("rate-limit" in r.stderr) or ("non-VTT" in r.stderr)
            if transient and attempt < args.max_attempts:
                wait = args.cooldown * attempt + random.uniform(0, 3)
                print(f"  rate-limited — cooling down {wait:.0f}s "
                      f"[attempt {attempt}/{args.max_attempts}]", flush=True)
                time.sleep(wait)
                continue
            failures.append(vid)
            break

    ok = len(ids) - len(failures)
    print(f"\ndone: {ok}/{len(ids)} ok" + (f"; failed: {', '.join(failures)}" if failures else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
