"""ytdistill CLI (design doc §3).

    ytdistill <url|id> [--json [PATH]] [--html PATH] [--review PATH]
                       [--save-transcript] [--save-run]
                       [--model M] [--api-key K] [--lang L]
                       [--no-thumbs] [--no-sponsorblock]

Happy path: metadata + captions -> SponsorBlock -> clean/dedupe -> thumbnails
-> LLM -> validate -> render. Caches (transcripts, runs) live under
~/.ytdistill by default (override with YTDISTILL_HOME).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from . import cache
from . import captions as cap
from . import distill as dl
from . import fetch as fetch_mod
from . import render as rn
from . import sponsorblock as sb
from . import thumbs as th
from .models import Summary

CACHE_DIR = Path(os.environ.get("YTDISTILL_HOME", str(Path.home() / ".ytdistill")))


def _fetch_cached(target: str, args):
    """Metadata + captions, from the on-disk cache when possible so a re-run
    needs neither yt-dlp nor the network (design doc §6)."""
    vid = fetch_mod.video_id_from(target)
    if vid and not args.refresh:
        hit = cache.load_fetch(vid)
        if hit:
            return hit
    meta, vtt, source = fetch_mod.fetch(target, lang=args.lang)
    cache.save_fetch(meta["video_id"], meta, vtt, source)
    return meta, vtt, source


def _apply_sponsorblock(cues, video_id: str, args):
    """Filter sponsor cues, caching the response (an empty list is a valid
    cached result). Returns (kept_cues, removed_seconds)."""
    segments = None if args.refresh else cache.load_sponsor(video_id)
    if segments is None:
        try:
            segments = sb.get_segments(video_id)
            cache.save_sponsor(video_id, segments)
        except Exception as exc:  # best-effort, never fatal
            print(f"warning: SponsorBlock skipped ({exc})", file=sys.stderr)
            segments = []
    return sb.filter_cues(cues, segments)


def build_summary(target: str, args):
    """Run the full pipeline. Returns (summary, transcript, usage)."""
    meta, vtt, source = _fetch_cached(target, args)
    cues = cap.parse_vtt(vtt)

    removed = 0
    if not args.no_sponsorblock:
        cues, removed = _apply_sponsorblock(cues, meta["video_id"], args)

    transcript, _words = cap.clean_captions(cues, source)
    if not transcript.strip():
        raise RuntimeError("Transcript is empty after cleaning — nothing to distill.")

    if args.save_transcript:
        _save_transcript(meta["video_id"], transcript)

    thumbnails = [] if args.no_thumbs else th.from_metadata(meta)

    llm, usage = dl.distill(
        meta, transcript, provider=args.provider, model=args.model,
        api_key=args.api_key, use_cache=not args.refresh,
    )
    read_seconds = dl.estimate_read_seconds(llm)
    summary = Summary.from_llm(llm, meta, thumbnails, source, removed, read_seconds)
    return summary, transcript, usage


def _save_transcript(video_id: str, transcript: str) -> Path:
    d = CACHE_DIR / "transcripts"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{video_id}.txt"
    path.write_text(transcript, encoding="utf-8")
    return path


def _save_run(summary: Summary, transcript: str, raw_json: str, usage: dict,
              provider: str, model: str) -> Path:
    """Bundle a run for adversarial evaluation (see eval/rubric.md)."""
    d = CACHE_DIR / "runs" / summary.video_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "transcript.txt").write_text(transcript, encoding="utf-8")
    (d / "summary.json").write_text(raw_json, encoding="utf-8")
    run_meta = {
        "video_id": summary.video_id,
        "title": summary.title,
        "channel": summary.channel,
        "kind": summary.kind,
        "provider": provider,
        "model": model,
        "usage": usage or {},
    }
    (d / "run.json").write_text(json.dumps(run_meta, indent=2), encoding="utf-8")
    return d


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="ytdistill",
        description="Distill a YouTube video into the paragraph it should have been.",
    )
    p.add_argument("target", help="YouTube URL or 11-character video id")
    p.add_argument("--json", nargs="?", const="-", metavar="PATH",
                   help="write contract JSON (stdout if PATH omitted)")
    p.add_argument("--html", metavar="PATH", help="write single-file HTML summary")
    p.add_argument("--review", metavar="PATH",
                   help="write HTML review bundle (summary + transcript + JSON)")
    p.add_argument("--save-transcript", action="store_true",
                   help="cache the cleaned transcript for prompt iteration")
    p.add_argument("--save-run", action="store_true",
                   help="write a runs/<id>/ bundle for adversarial eval")
    p.add_argument("--provider", default=dl.DEFAULT_PROVIDER, choices=sorted(dl.DEFAULT_MODELS),
                   help=f"LLM provider (default {dl.DEFAULT_PROVIDER})")
    p.add_argument("--model", default=None,
                   help="model id (default per provider: "
                        + ", ".join(f"{k}={v}" for k, v in dl.DEFAULT_MODELS.items()) + ")")
    p.add_argument("--api-key", default=None,
                   help="API key (else OPENAI_API_KEY / ANTHROPIC_API_KEY env)")
    p.add_argument("--lang", default="en", help="caption language (default en)")
    p.add_argument("--no-thumbs", action="store_true")
    p.add_argument("--no-sponsorblock", action="store_true")
    p.add_argument("--refresh", action="store_true",
                   help="ignore the cache and re-pull from YouTube")
    p.add_argument("--version", action="version", version=f"ytdistill {__version__}")
    args = p.parse_args(argv)

    try:
        summary, transcript, usage = build_summary(args.target, args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    raw_json = summary.model_dump_json(indent=2)

    # Terminal render is the default only when no file output was requested.
    if not (args.json is not None or args.html or args.review):
        print(rn.render_terminal(summary))

    if args.json is not None:
        if args.json == "-":
            print(raw_json)
        else:
            Path(args.json).write_text(raw_json, encoding="utf-8")
    if args.html:
        Path(args.html).write_text(rn.render_html(summary), encoding="utf-8")
    if args.review:
        Path(args.review).write_text(
            rn.render_review_html(summary, transcript, raw_json), encoding="utf-8"
        )
    if args.save_transcript and not args.save_run:
        print(f"transcript cached under {CACHE_DIR / 'transcripts'}", file=sys.stderr)
    if args.save_run:
        model = args.model or dl.DEFAULT_MODELS.get(args.provider)
        path = _save_run(summary, transcript, raw_json, usage, args.provider, model)
        print(f"run saved: {path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
