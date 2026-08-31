"""Metadata + captions via yt-dlp (design doc §3).

Happy path only: the video has captions (manual preferred over auto). The
Whisper fallback the doc describes is intentionally not wired up in the PoC.

Isolated behind this one module so a YouTube-side change is a one-file fix
(design doc §6: "Expect caption-layer breakage").
"""

from __future__ import annotations

import re

import requests

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def normalize_url(url_or_id: str) -> str:
    if _ID_RE.match(url_or_id):
        return f"https://www.youtube.com/watch?v={url_or_id}"
    return url_or_id


def video_id_from(url_or_id: str):
    """Best-effort extract the 11-char video id from a URL or bare id (for cache
    keys), or None if it can't be determined without a network call."""
    if _ID_RE.match(url_or_id):
        return url_or_id
    m = re.search(r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/)([A-Za-z0-9_-]{11})", url_or_id)
    return m.group(1) if m else None


def _lang_track(track_map, lang):
    """Pick the caption track for `lang`, tolerating region variants (en-US)."""
    if not track_map:
        return None
    if lang in track_map:
        return track_map[lang]
    for key, val in track_map.items():
        if key.split("-")[0] == lang:
            return val
    return None


def _pick_vtt(track):
    for t in track:
        if t.get("ext") == "vtt":
            return t
    return track[0] if track else None


def fetch(url_or_id: str, lang: str = "en", timeout: float = 30.0):
    """Return (meta, vtt_text, transcript_source).

    transcript_source is "manual_captions" or "auto_captions"; raises if neither
    exists (Whisper fallback is not implemented in the PoC).
    """
    import yt_dlp  # lazy: keeps the rest of the package importable without it

    url = normalize_url(url_or_id)
    ydl_opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [lang],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    track = _lang_track(info.get("subtitles") or {}, lang)
    source = "manual_captions"
    if not track:
        track = _lang_track(info.get("automatic_captions") or {}, lang)
        source = "auto_captions"
    if not track:
        raise RuntimeError(
            f"No '{lang}' captions (manual or auto) for this video. "
            "Whisper fallback is not implemented in the PoC."
        )

    entry = _pick_vtt(track)
    if not entry or not entry.get("url"):
        raise RuntimeError("Caption track has no fetchable URL.")
    vtt_text = requests.get(entry["url"], timeout=timeout).text
    if "-->" not in vtt_text and not vtt_text.lstrip().startswith("WEBVTT"):
        # A YouTube/Google rate-limit "Sorry" page returns HTTP 200 with HTML
        # instead of the VTT. Detect it so we raise clearly and never cache it.
        raise RuntimeError(
            "caption download returned non-VTT content — almost certainly a "
            "YouTube/Google rate-limit page. Wait and retry, or run from a "
            "residential IP; nothing was cached."
        )

    meta = {
        "video_id": info.get("id", ""),
        "title": info.get("title", ""),
        "channel": info.get("channel") or info.get("uploader") or "",
        "duration_s": int(info.get("duration") or 0),
        "description": info.get("description") or "",
        "chapters": info.get("chapters") or [],
        "thumbnails": info.get("thumbnails") or [],
    }
    return meta, vtt_text, source
