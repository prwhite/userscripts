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

## YouTube Playlist Quick Remove

Shipped: "Remove N watched" pill for the loaded rows (1.2.0) — the loaded/rendered
rows whose resume-playback percent is ≥ `WATCHED_PERCENT`, arm/confirm, batched
`edit_playlist` with a one-per-request fallback.

### Pinned — the other three bulk variants
- **Remove watched from the WHOLE playlist.** Page through `browse`
  (`browseId: 'VL' + listId`) continuations to collect every `setVideoId` and its
  `thumbnailOverlayResumePlaybackRenderer.percentDurationWatched`, then reuse the
  batch remover. Reads fresh server data, so it also catches videos distilled in
  another tab without a reload. Needs a progress toast + navigate-away guard.
- **Remove ALL loaded rows / remove ALL from the whole playlist.** Same two
  skeletons minus the watched filter. Batch deletes with no undo → a real confirm
  dialog with the count, not arm/confirm.
- Unknowns to settle when built: the max actions per `edit_playlist` request
  (1.2.0 chunks at 50 and falls back to one-per-request); whether continuation
  tokens shift when removing mid-pagination (collect every id first, then remove).

### Risk — new playlist layout (`yt-lockup-view-model`)
Seen 2026-09-06 in a signed-out Chrome: a public playlist page rendered its rows as
24× `yt-lockup-view-model` (+ `yt-continuation-item-view-model`), with NO
`ytd-playlist-video-renderer` at all, and the lockup element's `.data` exposed no
enumerable keys. The script (× buttons and the watched pill) matches
`ytd-playlist-video-renderer` only, so if that layout reaches the signed-in Safari
session everything goes silently inert. If that day comes: read each lockup's video
id / `playlistEditEndpoint.actions[].setVideoId` from its menu model and its watched
percent from the thumbnail view-model's progress overlay, on a signed-in page.
