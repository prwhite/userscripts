"""VTT parse, rolling-window dedupe, and [mm:ss] markers.

Design doc §3: "Auto-caption cleanup is not optional ... the single most
consequential piece of plumbing in the project." YouTube's auto-captions are a
rolling two-line window, so naive VTT-to-text roughly doubles every word; we
dedupe by comparing the previous cue's tail against the current cue's head.

Pure stdlib on purpose — this is the module the JS port (phase 2) is diffed
against, and the one with real unit tests.
"""

from __future__ import annotations

import html
import re

_TAG_RE = re.compile(r"<[^>]+>")           # <c>, </c>, <00:00:00.000> inline tags
_WS_RE = re.compile(r"\s+")
_TS_RE = re.compile(r"(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})")


def _parse_ts(ts: str) -> float:
    m = _TS_RE.search(ts)
    if not m:
        return 0.0
    h, mnt, s, ms = (int(x) for x in m.groups())
    return h * 3600 + mnt * 60 + s + ms / 1000.0


def _clean_text(text: str) -> str:
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def parse_vtt(vtt: str) -> list[tuple[float, float, str]]:
    """Parse a WebVTT string into (start_s, end_s, text) cues."""
    cues: list[tuple[float, float, str]] = []
    blocks = re.split(r"\n[ \t]*\n", vtt.replace("\r\n", "\n").replace("\r", "\n"))
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        timing_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if timing_idx is None:
            continue  # header block: WEBVTT, NOTE, STYLE, Kind:, Language:
        left, _, right = lines[timing_idx].partition("-->")
        start = _parse_ts(left)
        end = _parse_ts(right)  # cue settings after the timestamp are ignored by the regex
        text = _clean_text(" ".join(lines[timing_idx + 1:]))
        if text:
            cues.append((start, end, text))
    return cues


def _overlap(prev_tail: list[str], cur: list[str], max_window: int = 60) -> int:
    """Largest k such that prev_tail[-k:] == cur[:k]."""
    limit = min(len(prev_tail), len(cur), max_window)
    for k in range(limit, 0, -1):
        if prev_tail[-k:] == cur[:k]:
            return k
    return 0


def dedupe_rolling(cues) -> list[tuple[str, float]]:
    """Collapse the rolling-window doubling into one (word, start_s) stream.

    Each auto-caption cue repeats the tail of the previous one and adds a few
    new words; we append only the non-overlapping remainder, tagging each word
    with the start time of the cue that introduced it.
    """
    words: list[tuple[str, float]] = []
    for start, _end, text in cues:
        toks = text.split()
        if not toks:
            continue
        tail = [w for w, _ in words[-_OVERLAP_WINDOW:]]
        k = _overlap(tail, toks)
        for w in toks[k:]:
            words.append((w, start))
    return words


_OVERLAP_WINDOW = 60


def flatten_cues(cues) -> list[tuple[str, float]]:
    """Manual captions are already clean — attach each word to its cue start."""
    words: list[tuple[str, float]] = []
    for start, _end, text in cues:
        for w in text.split():
            words.append((w, start))
    return words


def _fmt_marker(seconds: float) -> str:
    total = int(seconds)
    return f"[{total // 60:02d}:{total % 60:02d}]"


def to_transcript(words, interval_s: int = 30) -> str:
    """Render (word, start_s) pairs, inserting an [mm:ss] marker at the start of
    each interval bucket that actually contains words (no empty markers)."""
    out: list[str] = []
    last_bucket = -1
    for w, start in words:
        bucket = int(start // interval_s)
        if bucket != last_bucket:
            out.append(_fmt_marker(bucket * interval_s))
            last_bucket = bucket
        out.append(w)
    return " ".join(out)


def clean_captions(cues, source: str, interval_s: int = 30):
    """Full cleanup: dedupe (auto only), then timestamp markers.

    Returns (transcript_text, words) where words is the (word, start_s) list so
    callers can ground timestamps or diff against the JS port.
    """
    words = dedupe_rolling(cues) if source == "auto_captions" else flatten_cues(cues)
    return to_transcript(words, interval_s), words
