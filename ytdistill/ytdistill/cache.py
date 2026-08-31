"""On-disk cache of what we pull from YouTube, keyed by video id.

Re-running a video — prompt iteration, the compare loop — must not re-hit
YouTube: it's slow and risks rate-limiting/bot-blocks (design doc §6). We cache
the raw fetch (metadata + VTT + which track) and the SponsorBlock response, so a
second run needs neither yt-dlp nor the network. `--refresh` bypasses it.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("YTDISTILL_HOME", str(Path.home() / ".ytdistill"))) / "cache"


def _dir(video_id: str) -> Path:
    return CACHE_ROOT / video_id


def load_fetch(video_id: str):
    """Return (meta, vtt, source) if cached, else None."""
    d = _dir(video_id)
    meta_p, vtt_p = d / "meta.json", d / "captions.vtt"
    if not (meta_p.exists() and vtt_p.exists()):
        return None
    stored = json.loads(meta_p.read_text(encoding="utf-8"))
    source = stored.pop("_source", "manual_captions")
    return stored, vtt_p.read_text(encoding="utf-8"), source


def save_fetch(video_id: str, meta: dict, vtt: str, source: str) -> None:
    d = _dir(video_id)
    d.mkdir(parents=True, exist_ok=True)
    stored = dict(meta)
    stored["_source"] = source
    (d / "meta.json").write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "captions.vtt").write_text(vtt, encoding="utf-8")


def load_sponsor(video_id: str):
    """Return the cached segments (possibly empty), or None if never fetched."""
    p = _dir(video_id) / "sponsor.json"
    if not p.exists():
        return None
    return [tuple(seg) for seg in json.loads(p.read_text(encoding="utf-8"))]


def save_sponsor(video_id: str, segments) -> None:
    d = _dir(video_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "sponsor.json").write_text(json.dumps([list(s) for s in segments]), encoding="utf-8")


# ---- LLM output cache ----
# Keyed by a hash of provider+model+system_prompt+user_content, so a prompt edit
# (or a model/provider change) misses and re-runs, while an unchanged re-run — e.g.
# retrying a corpus after some fetches were rate-limited — is free and instant.

def _llm_dir() -> Path:
    return CACHE_ROOT / "llm"


def llm_key(provider: str, model: str, system_prompt: str, user_content: str) -> str:
    h = hashlib.sha256()
    for part in (provider, model, system_prompt, user_content):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def load_llm(key: str):
    p = _llm_dir() / f"{key}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def save_llm(key: str, data: dict) -> None:
    d = _llm_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{key}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
