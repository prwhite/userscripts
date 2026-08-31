# BACKLOG

Deferred ideas. Logged once here so we stop re-deriving them.

## ytdistill

Shipped since first draft: bounded/expiring cache (1.1.4), paragraph-broken
payload (1.1.3), top-layer popover overlay + follow-up chat (1.2.0).

**Dropped — shared-menu / per-thumbnail "Distill" action.** On desktop Safari,
cmd-clicking a thumbnail into a new tab + global auto-distill mode already does
the job, so the menu-injection work isn't worth it. (If ever revisited: it's a
single shared `ytd-menu-popup-renderer` under one `ytd-popup-container`, so it'd
be solve-once — resolve the target id from the "..." trigger, re-inject on menu
open, action = `window.open('watch?v=<id>#ytdistill')`.)

### Stretch / maybe
- Chat thread persistence — currently session-only (in memory). Persist per
  video if wanted, but keep it OUT of the bounded summary cache (transcripts are
  large); a separate small store or last-N only.
- GPU: no-autoplay is a mitigation, not a fix — building the player likely leaks
  GPU regardless. The top-layer overlay avoids the flicker but not the leak;
  `~/me/bin/py/gpukick.py` remains the real remedy.
