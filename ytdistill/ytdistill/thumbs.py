"""Thumbnails from yt-dlp metadata.

PoC happy path: use the official thumbnail set metadata already gives us. The
doc's i.ytimg frame-probing (hq1/hq2/hq3) + perceptual-hash dedupe is a
documented follow-up (design doc §3 and §8 open question), not wired up here.
"""

from __future__ import annotations

from .models import Thumbnail


def from_metadata(meta: dict, cap: int = 8) -> list[Thumbnail]:
    """Official thumbnails, de-duped by URL, largest-first, capped."""
    seen: set[str] = set()
    out: list[Thumbnail] = []
    for t in meta.get("thumbnails", []) or []:
        url = t.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(
            Thumbnail(
                url=url,
                w=int(t.get("width") or 0),
                h=int(t.get("height") or 0),
                role="official",
            )
        )
    out.sort(key=lambda t: t.w * t.h, reverse=True)
    return out[:cap]
