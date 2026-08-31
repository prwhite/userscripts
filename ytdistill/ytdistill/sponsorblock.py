"""SponsorBlock: drop caption cues that fall inside sponsor/intro/outro ranges.

Design doc §3: crowd-sourced, so coverage is good on large channels and absent
on small ones — a 404 (no data) is a normal, non-fatal outcome.
"""

from __future__ import annotations

import json

import requests

API = "https://sponsor.ajay.app/api/skipSegments"
DEFAULT_CATEGORIES = ("sponsor", "selfpromo", "interaction", "intro", "outro")


def get_segments(video_id: str, categories=DEFAULT_CATEGORIES, timeout: float = 15.0):
    """Return [(start_s, end_s), ...]. Empty list when the video has no crowd data."""
    params = {"videoID": video_id, "categories": json.dumps(list(categories))}
    r = requests.get(API, params=params, timeout=timeout)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return [(seg["segment"][0], seg["segment"][1]) for seg in r.json()]


def filter_cues(cues, segments):
    """Drop cues whose midpoint falls inside a segment.

    Returns (kept_cues, removed_seconds) where removed_seconds is the total
    length of the returned sponsor ranges (design doc: "record total seconds cut").
    """
    if not segments:
        return list(cues), 0
    kept = []
    for start, end, text in cues:
        mid = (start + end) / 2.0
        if any(a <= mid <= b for a, b in segments):
            continue
        kept.append((start, end, text))
    removed = int(sum(b - a for a, b in segments))
    return kept, removed
