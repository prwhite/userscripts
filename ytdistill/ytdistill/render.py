"""Renderers: terminal, single-file HTML, and an HTML review bundle.

Deep-linked timestamps (design doc §1 stretch goal): any grounded at_s becomes
a `watch?v=...&t=Ns` link, so the summary doubles as a table of contents into
the one segment that matters.
"""

from __future__ import annotations

import html

from . import __version__
from .models import Summary


def _fmt_ts(seconds) -> str:
    total = int(seconds)
    m, s = divmod(total, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def watch_url(video_id: str, at_s=None) -> str:
    base = f"https://www.youtube.com/watch?v={video_id}"
    return f"{base}&t={int(at_s)}s" if at_s is not None else base


# ---------------------------------------------------------------- terminal ---

def render_terminal(s: Summary) -> str:
    saved = max(0, s.watch_seconds - s.read_seconds)
    lines = [
        s.title,
        f"{s.channel} · {_fmt_ts(s.duration_s)}",
        f"~{s.read_seconds}s read vs {_fmt_ts(s.watch_seconds)} watch  (saves ~{_fmt_ts(saved)})",
        f"kind: {s.kind}",
        "",
        s.payload,
    ]
    if s.tease:
        ans = s.tease.answer
        if s.tease.answered_at_s is not None:
            ans += f"  [{_fmt_ts(s.tease.answered_at_s)}]"
        lines += ["", f"Q: {s.tease.question}", f"A: {ans}"]
    if s.points:
        lines.append("")
        for p in s.points:
            ts = f"  [{_fmt_ts(p.at_s)}]" if p.at_s is not None else ""
            lines.append(f"{p.rank}. {p.label} — {p.detail}{ts}")
    if s.notes:
        lines += ["", "Notes:"] + [f"  · {n}" for n in s.notes]
    if s.gaps:
        lines += ["", "Gaps:"] + [f"  ! {g}" for g in s.gaps]
    return "\n".join(lines)


# -------------------------------------------------------------------- HTML ---

_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#666; --quiet:#f4f4f5; --accent:#2a7ae2; --border:#e2e2e5; }
@media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#e8e8ea; --muted:#9a9aa2; --quiet:#202024; --accent:#6db3ff; --border:#303036; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:720px; margin:0 auto; padding:32px 20px 80px; }
h1 { font-size:1.5rem; line-height:1.25; margin:0 0 4px; }
.meta { color:var(--muted); font-size:.85rem; margin:0 0 24px; }
.kind { text-transform:uppercase; letter-spacing:.05em; font-size:.72rem; }
.payload { font-size:1.4rem; line-height:1.4; font-weight:600; margin:0 0 28px; }
.thumbs { display:flex; gap:8px; overflow-x:auto; padding-bottom:8px; margin:0 0 28px; }
.thumbs img { height:90px; border-radius:6px; border:1px solid var(--border); }
.tease { border-left:3px solid var(--accent); padding:2px 14px; margin:0 0 24px; }
.tease .q { color:var(--muted); margin:0 0 4px; }
.tease .a { margin:0; font-weight:600; }
ol.points { padding-left:1.4em; margin:0 0 24px; }
ol.points li { margin:0 0 10px; }
ol.points .label { font-weight:600; }
a.ts { color:var(--accent); text-decoration:none; font-variant-numeric:tabular-nums; white-space:nowrap; }
a.ts:hover { text-decoration:underline; }
.quiet { background:var(--quiet); border-radius:8px; padding:12px 16px; margin:0 0 16px; }
.quiet h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 8px; }
.quiet ul { margin:0; padding-left:1.2em; }
.quiet li { margin:0 0 6px; font-size:.92rem; }
.gaps { border:1px solid var(--border); }
details { margin-top:28px; }
summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
pre { background:var(--quiet); border-radius:8px; padding:14px; overflow-x:auto; font-size:.8rem; }
.transcript { white-space:pre-wrap; font-size:.85rem; line-height:1.7; }
footer { color:var(--muted); font-size:.72rem; margin-top:40px; }
</style>
</head>
<body>
<main>
"""

_TAIL = """
<footer>ytdistill v__VERSION__</footer>
</main>
</body>
</html>
"""


def _ts_link(video_id, at_s) -> str:
    if at_s is None:
        return ""
    return f' <a class="ts" href="{watch_url(video_id, at_s)}">[{_fmt_ts(at_s)}]</a>'


def _summary_body(s: Summary) -> str:
    e = html.escape
    saved = max(0, s.watch_seconds - s.read_seconds)
    out = [
        f"<header><h1>{e(s.title)}</h1>",
        f'<p class="meta">{e(s.channel)} · {_fmt_ts(s.duration_s)} · '
        f"~{s.read_seconds}s read vs {_fmt_ts(s.watch_seconds)} watch · saves ~{_fmt_ts(saved)} · "
        f'<span class="kind">{e(s.kind)}</span></p></header>',
        f'<p class="payload">{e(s.payload)}</p>',
    ]
    if s.thumbnails:
        thumbs = "".join(
            f'<a href="{e(t.url)}" target="_blank" rel="noopener">'
            f'<img src="{e(t.url)}" alt="" loading="lazy"></a>'
            for t in s.thumbnails
        )
        out.append(f'<div class="thumbs">{thumbs}</div>')
    if s.tease:
        ans = e(s.tease.answer) + _ts_link(s.video_id, s.tease.answered_at_s)
        out.append(
            f'<div class="tease"><p class="q">{e(s.tease.question)}</p><p class="a">{ans}</p></div>'
        )
    if s.points:
        items = "".join(
            f'<li><span class="label">{e(p.label)}</span> — {e(p.detail)}'
            f"{_ts_link(s.video_id, p.at_s)}</li>"
            for p in s.points
        )
        out.append(f'<ol class="points">{items}</ol>')
    if s.notes:
        out.append(
            '<div class="quiet"><h2>Notes</h2><ul>'
            + "".join(f"<li>{e(n)}</li>" for n in s.notes)
            + "</ul></div>"
        )
    if s.gaps:
        out.append(
            '<div class="quiet gaps"><h2>Gaps</h2><ul>'
            + "".join(f"<li>{e(g)}</li>" for g in s.gaps)
            + "</ul></div>"
        )
    return "\n".join(out)


def _document(title: str, body: str) -> str:
    return _HEAD.replace("__TITLE__", html.escape(title)) + body + _TAIL.replace("__VERSION__", __version__)


def render_html(s: Summary) -> str:
    return _document(s.title, _summary_body(s))


def render_review_html(s: Summary, transcript: str, raw_json: str) -> str:
    """Human-in-the-loop review: the summary, then the cleaned timestamped
    transcript and the raw contract JSON, so a judgment call takes seconds."""
    e = html.escape
    extra = (
        "<details open><summary>Cleaned transcript (what the model saw)</summary>"
        f'<div class="transcript">{e(transcript)}</div></details>'
        "<details><summary>Contract JSON</summary>"
        f"<pre>{e(raw_json)}</pre></details>"
    )
    return _document(s.title, _summary_body(s) + extra)
