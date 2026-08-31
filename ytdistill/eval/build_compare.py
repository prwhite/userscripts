#!/usr/bin/env python3
"""Build the side-by-side comparison page: OpenAI (pipeline) vs Claude (me).

For each corpus video it pairs the pipeline's summary
(~/.ytdistill/runs/<id>/summary.json) with Claude's distillation
(eval/claude/<id>.json) and renders one self-contained HTML page scoring the
rubric metrics — kind, payload, answer timestamp, gaps, voice — with the two
summaries next to each other.

    python eval/build_compare.py            # -> eval/compare.html
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE / "corpus.md"
CLAUDE_DIR = HERE / "claude"
OUT = HERE / "compare.html"
RUNS = Path(os.environ.get("YTDISTILL_HOME", str(Path.home() / ".ytdistill"))) / "runs"

_URL_ID = re.compile(r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/)([A-Za-z0-9_-]{11})")
_BARE_ID = re.compile(r"\b([A-Za-z0-9_-]{11})\b")
_BANNED = re.compile(r"\bthe (video|creator|author|narrator|presenter) (discuss|explain|cover|show|talk|describe|mention|highlight)", re.I)
_BANNED2 = re.compile(r"\bthis video\b", re.I)


def parse_corpus(path: Path):
    """Yield (id, tag, title) in file order."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        title_m = re.search(r'"([^"]*)"', line)
        title = title_m.group(1) if title_m else ""
        rest = re.sub(r'"[^"]*"', "", line)
        parts = [p.strip() for p in rest.split(",")]
        m = _URL_ID.search(parts[0]) or _BARE_ID.search(parts[0])
        if not m:
            continue
        tag = parts[1] if len(parts) > 1 and parts[1] else ""
        rows.append((m.group(1), tag, title))
    return rows


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ---------- rubric metric helpers ----------

def voice_offenders(s: dict) -> list[str]:
    """Return banned phrases found in payload/notes (the 'voice' rubric check)."""
    text = (s.get("payload") or "") + " " + " ".join(s.get("notes") or [])
    hits = [m.group(0) for m in _BANNED.finditer(text)]
    hits += [m.group(0) for m in _BANNED2.finditer(text)]
    return hits


def timestamps(s: dict):
    ts = []
    tease = s.get("tease") or {}
    if isinstance(tease, dict) and tease.get("answered_at_s") is not None:
        ts.append(int(tease["answered_at_s"]))
    for p in s.get("points") or []:
        if p.get("at_s") is not None:
            ts.append(int(p["at_s"]))
    return ts


def ts_problems(s: dict, duration_s: int):
    """Timestamps that are impossible (beyond the video) or a suspicious 0:00 tease answer."""
    problems = []
    for t in timestamps(s):
        if duration_s and t > duration_s:
            problems.append(f"{_hhmm(t)} > {_hhmm(duration_s)} (past end)")
    tease = s.get("tease") or {}
    if isinstance(tease, dict) and tease.get("answered_at_s") == 0:
        problems.append("tease answered at 0:00 (suspect)")
    return problems


def _hhmm(seconds) -> str:
    t = int(seconds)
    m, s = divmod(t, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ---------- rendering ----------

def _side(summary: dict, video_id: str, duration_s: int) -> str:
    if not summary:
        return '<div class="side missing">— not distilled yet —</div>'
    e = html.escape
    out = [f'<div class="side">']
    out.append(f'<span class="kind">{e(summary.get("kind","?"))}</span>')
    paras = [p.strip() for p in re.split(r"\n{2,}", summary.get("payload", "") or "") if p.strip()]
    out.append('<div class="payload">' + "".join(f"<p>{e(p)}</p>" for p in paras) + "</div>")

    tease = summary.get("tease") or {}
    if isinstance(tease, dict) and tease:
        ans = e(tease.get("answer", ""))
        at = tease.get("answered_at_s")
        if at is not None:
            ans += f' <span class="ts">[{_hhmm(at)}]</span>'
        out.append(f'<div class="tease"><div class="q">{e(tease.get("question",""))}</div>'
                   f'<div class="a">{ans}</div></div>')

    pts = summary.get("points") or []
    if pts:
        items = ""
        for p in pts:
            at = f' <span class="ts">[{_hhmm(p["at_s"])}]</span>' if p.get("at_s") is not None else ""
            items += f'<li><b>{e(p.get("label",""))}</b> — {e(p.get("detail",""))}{at}</li>'
        out.append(f'<ol class="points">{items}</ol>')

    notes = summary.get("notes") or []
    if notes:
        out.append('<div class="meta"><span>notes</span><ul>'
                   + "".join(f"<li>{e(n)}</li>" for n in notes) + "</ul></div>")

    # rubric flags
    voice = voice_offenders(summary)
    tsp = ts_problems(summary, duration_s)
    gaps = summary.get("gaps") or []
    out.append('<div class="flags">')
    out.append(f'<span class="flag {"bad" if voice else "ok"}">voice {"✗ " + e(voice[0]) if voice else "✓"}</span>')
    out.append(f'<span class="flag {"bad" if tsp else "ok"}">timestamps {"✗ " + e(tsp[0]) if tsp else "✓"}</span>')
    if gaps:
        out.append('<div class="gaps"><span>gaps</span><ul>'
                   + "".join(f"<li>{e(g)}</li>" for g in gaps) + "</ul></div>")
    else:
        out.append('<span class="flag ok">gaps: none</span>')
    out.append("</div>")
    out.append("</div>")
    return "\n".join(out)


def _card(video_id: str, tag: str, title: str, openai: dict, claude: dict) -> str:
    e = html.escape
    duration = (openai or {}).get("duration_s") or (claude or {}).get("duration_s") or 0
    watch = f"https://www.youtube.com/watch?v={video_id}"
    ok = (openai or {}).get("kind", "—")
    ck = (claude or {}).get("kind", "—")
    kind_row = (f'<div class="kinds"><span>your tag: <b>{e(tag or "—")}</b></span>'
                f'<span>OpenAI: <b>{e(ok)}</b></span><span>Claude: <b>{e(ck)}</b></span>'
                f'{"<span class=div>kind differs</span>" if ok != ck else ""}</div>')
    return (
        f'<section class="card">'
        f'<h2><a href="{watch}" target="_blank" rel="noopener">{e(title or video_id)}</a>'
        f' <span class="id">{e(video_id)} · {_hhmm(duration)}</span></h2>'
        f'{kind_row}'
        f'<div class="cols"><div class="col"><h3>OpenAI (gpt-4o)</h3>{_side(openai, video_id, duration)}</div>'
        f'<div class="col"><h3>Claude (me)</h3>{_side(claude, video_id, duration)}</div></div>'
        f'</section>'
    )


def build() -> Path:
    rows = parse_corpus(CORPUS)
    cards, have_both, kind_diffs = [], 0, 0
    for vid, tag, title in rows:
        openai = load_json(RUNS / vid / "summary.json")
        claude = load_json(CLAUDE_DIR / f"{vid}.json")
        if openai and claude:
            have_both += 1
            if openai.get("kind") != claude.get("kind"):
                kind_diffs += 1
        cards.append(_card(vid, tag, title, openai, claude))

    summary_line = (f"{len(rows)} videos · both sides on {have_both} · "
                    f"kind disagreements: {kind_diffs}")
    doc = _SHELL.replace("__SUMMARY__", html.escape(summary_line)).replace("__CARDS__", "\n".join(cards))
    OUT.write_text(doc, encoding="utf-8")
    return OUT


_SHELL = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ytdistill — OpenAI vs Claude</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--panel:#f5f5f6;--line:#e2e2e5;--accent:#2a7ae2;--bad:#c0392b;--ok:#2a8a4a;}
@media(prefers-color-scheme:dark){:root{--bg:#151517;--fg:#e8e8ea;--muted:#9a9aa2;--panel:#1e1e22;--line:#303036;--accent:#6db3ff;--bad:#ff6b6b;--ok:#5fd08a;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.5;
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
header{padding:20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
header h1{margin:0;font-size:1.1rem}
header .s{color:var(--muted);font-size:.85rem}
main{max-width:1100px;margin:0 auto;padding:16px}
.card{border:1px solid var(--line);border-radius:10px;margin:0 0 20px;overflow:hidden}
.card h2{margin:0;padding:12px 16px;font-size:1rem;background:var(--panel)}
.card h2 a{color:inherit;text-decoration:none}
.card h2 .id{color:var(--muted);font-weight:400;font-size:.78rem}
.kinds{display:flex;gap:16px;flex-wrap:wrap;padding:8px 16px;font-size:.82rem;color:var(--muted);border-bottom:1px solid var(--line)}
.kinds .div{color:var(--bad);font-weight:600}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0}
.col{padding:14px 16px}
.col:first-child{border-right:1px solid var(--line)}
.col h3{margin:0 0 8px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.side .kind{display:inline-block;text-transform:uppercase;font-size:.68rem;letter-spacing:.05em;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin-bottom:6px}
.side.missing{color:var(--muted);font-style:italic}
.payload{font-weight:600;margin:.3em 0 .6em}
.payload p{margin:0 0 .5em}.payload p:last-child{margin-bottom:0}
.tease{border-left:3px solid var(--accent);padding:2px 10px;margin:.4em 0}
.tease .q{color:var(--muted);font-size:.9em}
.tease .a{font-weight:600}
ol.points{padding-left:1.3em;margin:.4em 0}
ol.points li{margin:0 0 6px;font-size:.92em}
.ts{color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap}
.meta,.gaps{font-size:.85em;margin:.5em 0}
.meta span,.gaps span{color:var(--muted);text-transform:uppercase;font-size:.7rem;letter-spacing:.05em}
.meta ul,.gaps ul{margin:.2em 0;padding-left:1.2em}
.flags{margin-top:.6em;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.flag{font-size:.78rem;border-radius:6px;padding:1px 8px;border:1px solid var(--line)}
.flag.ok{color:var(--ok)}
.flag.bad{color:var(--bad);border-color:var(--bad)}
.gaps{flex-basis:100%}
@media(max-width:720px){.cols{grid-template-columns:1fr}.col:first-child{border-right:none;border-bottom:1px solid var(--line)}}
</style></head>
<body>
<header><h1>ytdistill — OpenAI vs Claude, side by side</h1><div class="s">__SUMMARY__</div></header>
<main>
__CARDS__
</main>
</body></html>
"""


if __name__ == "__main__":
    print(f"wrote {build()}")
