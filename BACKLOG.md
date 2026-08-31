# BACKLOG

Deferred ideas. Logged once here so we stop re-deriving them.

## ytdistill

### Shared-menu "Distill" action (next build)
Inject one **"Distill"** item into YouTube's single shared "..." menu
(`ytd-popup-container` → one `ytd-menu-popup-renderer`, reused for every
thumbnail across home/search/sidebar/related). Solve once, not per-thumbnail.
- Resolve the target video id from the **trigger** click (walk up from the
  `ytd-menu-renderer` "..." button to the enclosing renderer's
  `a[href*="/watch?v="]`) — the menu itself doesn't carry the id.
- Re-inject on each menu open (YouTube repopulates the item list) via a
  MutationObserver on the shared listbox.
- Action: `window.open('watch?v=<id>#ytdistill', '_blank')` → the v1.1 distill
  engine (no-autoplay + auto-distill on `#ytdistill`) does the rest, so this
  layer is thin.
- Wrinkle: menu is shadow-DOM; inject a styled lookalike row (match ~16px
  padding / height / hover), not a real `ytd-menu-service-item-renderer`.

### Chat / follow-up questions on a summary
Turn the distill overlay into a mini chat so you can ask follow-ups.
- **No special provider tier needed.** Chat Completions is stateless; we hold
  context by resending the message array. The transcript already lives in the
  first user message, so follow-ups can reference it. (Assistants API / stateful
  threads exist but add cost + complexity for no benefit here.)
- messages = [system, {user: original content+transcript}, {assistant: summary},
  {user: question}, …]; send plain chat (not the strict JSON schema) for
  free-form answers; append Q&A to the overlay; persist the thread per-video in
  the cache so reopening restores it.
- Cost grows linearly (~full history resent each turn ≈ 1–2¢/turn at gpt-4.1);
  trim/summarize old turns only if it ever matters. Context window is a non-issue
  (gpt-4.1 is large).

### Break up the dense summary paragraph
Split `payload` into a few short paragraphs by concept instead of one wall.
- Prompt change (in `prompts/distill.md` AND the userscript's mirrored
  SYSTEM_PROMPT — keep in sync): separate distinct ideas with a blank line,
  2–4 short paragraphs.
- Render change: split `payload` on `\n\n` → one `<p>` per chunk (overlay +
  Python `render.py`). Lighter than a schema change (payload → array).

### Stretch / maybe
- Per-thumbnail "Distill" buttons everywhere — superseded by the shared-menu
  approach above; only if the menu route proves insufficient.
- GPU: no-autoplay is a mitigation, not a fix — building the player likely leaks
  GPU regardless. `~/me/bin/py/gpukick.py` remains the real remedy.
