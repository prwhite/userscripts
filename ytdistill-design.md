# ytdistill — design doc

A personal tool that turns a 10-minute YouTube video into the paragraph it should
have been.

Three phases, sharing one prompt and one output contract:

1. **`ytdistill` CLI** (Python) — where the prompt gets tuned against a fixed
   corpus. Cloud LLM.
2. **`ytdistill.user.js`** (userscript) — the daily driver. Runs in Safari on
   both macOS and iOS. Cloud LLM via an API key held in extension storage.
3. **Native Safari Web Extension** (optional, later) — the same JS plus a native
   bridge to on-device Apple Intelligence. Only worth building if the
   privacy/offline/no-key properties turn out to matter.

Phase 2 is the important one. It's ~90% of the native extension's code with none
of its build ceremony, and the port path in phase 3 is mechanical.

Non-goals: multi-user, hosting, publishing summaries, channel monitoring, any
form of corpus accumulation. Staying single-user is what keeps this legally and
operationally boring.

---

## 1. Shared contract

Everything downstream of the model consumes this. Python emits it as JSON; the
userscript consumes the same JSON; a future Swift phase mirrors it as a
`@Generable` struct so guided generation enforces the shape.

```jsonc
{
  "video_id": "dQw4w9WgXcQ",
  "title": "...",
  "channel": "...",
  "duration_s": 612,
  "kind": "tease" | "listicle" | "tutorial" | "review" | "narrative",

  // The one thing the video exists to say. Present for every kind.
  // 1-3 sentences, plain, no hedging, no "the video explains that".
  "payload": "...",

  // Populated when kind == "tease". The question the title/thumbnail poses,
  // and the timestamp where the video finally answers it.
  "tease": {
    "question": "...",
    "answer": "...",
    "answered_at_s": 431
  },

  // Populated when kind == "listicle". Ordered as the video orders them.
  "points": [
    { "rank": 1, "label": "...", "detail": "...", "at_s": 92 }
  ],

  // 2-5 bullets. Supporting substance that isn't in payload/points.
  "notes": ["..."],

  // Claims the creator asserts without support, or caveats they skip.
  // Empty array is fine and common. Do not manufacture entries.
  "gaps": ["..."],

  "read_seconds": 22,        // estimated read time of this summary
  "watch_seconds": 612,      // for the "you saved N minutes" line
  "thumbnails": [
    { "url": "...", "w": 1280, "h": 720, "role": "official" | "auto" | "storyboard" }
  ],
  "transcript_source": "manual_captions" | "auto_captions" | "whisper",
  "sponsor_segments_removed_s": 74
}
```

Field discipline matters more than it looks. `payload` being mandatory and
`points` being conditional is what stops the model from producing a shapeless
summary for a listicle or a bulleted list for a single-idea video.

### Stretch goal — deep-linked timestamps (all phases)

When the summary is built from a transcript that carries caption timing, every
extracted moment that can be grounded in a cue should travel through the pipeline
with its `at_s`, and the renderer should surface it as a deep link to that exact
moment in the video. This applies to all three manifestations of the tool.

- `points[].at_s` and `tease.answered_at_s` already carry this. Extend the same
  discipline to `notes` (and any future extracted moment): a note that
  corresponds to a specific point in the video should carry an optional `at_s`.
  This is a contract change (note becomes `{ text, at_s? }`) worth deferring
  until the string form is proven.
- The model may only emit an `at_s` it can ground in a caption cue (the prompt
  already forbids ungrounded timestamps). An omitted `at_s` renders as plain
  text with no link — never a fabricated jump.
- UI modality is unsettled and phase-specific — the same `at_s`, three click
  handlers:
  - **CLI / HTML render:** an anchor to `https://www.youtube.com/watch?v=<id>&t=<at_s>s`.
  - **Userscript overlay:** seek the underlying player
    (`document.querySelector('video').currentTime = at_s`) and dismiss.
  - **Native extension:** same in-page seek.

The value: the summary becomes a table of contents into the one segment that
matters, not merely a replacement for watching. Carry the timing end-to-end so
surfacing it is always a render-layer decision, never a re-extraction.

---

## 2. The system prompt

This is the actual product. Everything else is plumbing. Keep it in one file
(`prompts/distill.md`), and have the userscript build embed it from the same
file so there's a single source of truth.

```
You are extracting the substance from a YouTube video transcript. The person
reading your output has chosen not to watch the video. Assume they are
impatient and technically literate.

Most videos in this category withhold their actual content to maximise watch
time. Your job is to defeat that structure, not to reproduce it.

FIRST, classify the video:

- TEASE: the title or thumbnail poses a question, promises a reveal, or implies
  a surprising result, and the video defers answering it. Almost anything of the
  form "I tried X for 30 days", "the REAL reason...", "you're doing X wrong".
- LISTICLE: an enumerated set of items, tips, products, or mistakes.
- TUTORIAL: a procedure the viewer is meant to follow.
- REVIEW: an evaluation of one or a few things, ending in a verdict.
- NARRATIVE: a story, essay, or documentary with no single extractable claim.

THEN:

For a TEASE, your first job is to state the withheld thing plainly, in the
opening sentence, with no preamble. Identify the question the video poses and
answer it. If the video never actually answers it — this is common — say so
explicitly rather than paraphrasing the runaround.

For a LISTICLE, extract every item, in the video's own order, with its rank.
Give each a short label and one line of detail. If the video promises N items
and delivers fewer, or repeats items, note it in gaps. Do not merge items to
make the list tidier.

For a TUTORIAL, give the procedure as ordered steps, including any prerequisite,
version, or hardware constraint the creator mentions in passing.

For a REVIEW, lead with the verdict and the price, then the reasoning.

For a NARRATIVE, give the arc in three sentences. Do not invent a thesis.

RULES:

- Never write "the video discusses", "the creator explains", "this video covers".
  State the content directly, as fact-with-attribution where attribution matters.
- Never describe the video's structure. The reader does not care that there is
  an intro.
- Prefer the creator's specific numbers, part names, versions, prices, and
  model numbers over your paraphrase of them. Specificity is the whole value.
- The transcript is machine-generated. It has no punctuation or speaker labels
  and mangles proper nouns and technical jargon. Use the video title, channel
  name, and description to repair obvious mis-transcriptions — but only where
  you are confident. Do not guess at a term you cannot reconstruct; write it as
  heard and flag it in gaps.
- Timestamps come from the caption timing data. Only emit a timestamp you can
  ground in a caption cue.
- If the transcript is too thin, corrupted, or off-topic to summarise, say that
  in payload rather than producing filler.
- Populate gaps only with real omissions: an unsupported claim, an undisclosed
  sponsorship, a missing control in a comparison, a "link in the description"
  substituting for an explanation. An empty gaps array is a valid and honest
  answer.
```

**Prompt inputs** (assembled by the caller, in this order): title, channel,
duration, description first 500 chars, chapter list if present, then the
cleaned transcript with `[mm:ss]` markers every ~30s.

---

## 3. Phase 1 — Python CLI

Purpose: a fast iteration loop for the prompt, and a reference implementation of
the transcript pipeline that the userscript can be diffed against.

### Pipeline

```
video id/url
  → metadata      (yt-dlp -J, no download)
  → captions      (yt-dlp --write-auto-sub --write-sub --sub-format vtt --skip-download)
      ↳ fallback  (yt-dlp -f bestaudio → whisper.cpp --metal)
  → sponsor cut   (SponsorBlock API, segment ranges vs cue timings)
  → clean         (dedupe rolling-window auto-caption lines, collapse, add [mm:ss])
  → thumbnails    (probe + dedupe)
  → LLM call      (one shot, structured output forced)
  → validate      (pydantic model == the shared contract)
  → render        (terminal, or single-file HTML with thumbs)
```

### Notes per stage

**Captions.** No official API exists for arbitrary videos — the Data API v3
`captions` resource only serves videos you own, via OAuth. Use `yt-dlp` rather
than `youtube-transcript-api`; it handles more edge cases and is patched faster
when YouTube's internal endpoints move. Prefer manual captions over ASR when
both exist. Expect this layer to break periodically.

**Auto-caption cleanup is not optional.** YouTube's auto-captions are delivered
as a rolling two-line window, so naïve VTT-to-text roughly doubles every word.
Dedupe by tracking the previous cue's tail against the current cue's head. This
is the single most consequential piece of plumbing in the project.

**SponsorBlock.** `GET https://sponsor.ajay.app/api/skipSegments?videoID=...`
with categories `sponsor,selfpromo,interaction,intro,outro`. Drop caption cues
whose midpoint falls inside a returned range; record total seconds cut.
Crowd-sourced, so coverage is good on large channels and absent on small ones.

**Thumbnails.** Two sources, merged:

- `videoDetails.thumbnail.thumbnails[]` from metadata — the official set.
- Probe the auto-generated frame candidates:
  `https://i.ytimg.com/vi/<ID>/{maxresdefault,sddefault,hqdefault,mqdefault,default,hq1,hq2,hq3}.jpg`
  plus the `vi_webp` equivalents.

`maxresdefault` 404s on many videos. Some missing variants return a 120×90 grey
placeholder with HTTP 200 rather than 404 — filter those by content hash, not
status code. `hq1/hq2/hq3` are the three frames YouTube auto-extracts and offers
the creator at upload; they are frequently more informative than the chosen
clickbait thumbnail, which is the point of collecting them. Dedupe by perceptual
hash so you don't show five resolutions of the same image.

**Model call.** ~1500 words of speech ≈ 2k tokens for a 10-minute video, so a
single call with no chunking, costing fractions of a cent. Force the output
schema via structured outputs rather than asking for JSON in prose. The provider
is pluggable behind one interface — bring-up uses OpenAI, Anthropic works through
the same structured-output path — while phases 2 and 3 still target the
Anthropic/Apple stack described below.

### Layout

```
ytdistill/
  __main__.py
  fetch.py        # yt-dlp wrappers, metadata + captions
  captions.py     # VTT parse, rolling-window dedupe, timestamp markers
  sponsorblock.py
  thumbs.py       # probe, placeholder filter, phash dedupe
  distill.py      # prompt assembly + model call
  models.py       # pydantic: the shared contract
  render.py       # terminal + single-file HTML
  prompts/distill.md
```

CLI:

```
ytdistill <url|id> [--json] [--html out.html] [--no-thumbs]
                   [--force-whisper] [--model ...] [--save-transcript]
```

`--save-transcript` writes to a local cache for prompt iteration. Build a corpus
of ~20 known-annoying videos as a regression set — re-running the prompt against
fixed transcripts is what makes tuning tractable.

**Whisper fallback**: `yt-dlp -f bestaudio` → `whisper.cpp` with the Metal
backend. Ten minutes of audio transcribes in well under a minute on Apple
silicon. Worth having in the CLI; not worth attempting in the browser.

---

## 4. Phase 2 — the userscript (primary target)

### Why this is the right shape

- No Xcode, no signing, no provisioning profile, no developer account to run
  your own code on your own phone.
- One file, edited in place, reloaded instantly.
- Identical on macOS and iOS Safari.
- **It solves iOS entirely.** From the YouTube app: share → Safari → page loads →
  script runs. No share extension, no offscreen `WKWebView`, no URL-parameter
  handshake to auto-invoke anything.

### Prerequisite

A userscript manager — the choice is non-normative. For bring-up, target
**Tampermonkey**, the manager the rest of these userscripts already run in, so
this script shares their install flow and API idioms. **Userscripts** by quoid is
a notable alternative where native iOS Safari support and a fully open-source
stack matter (free, actively maintained, full `GM.xmlHttpRequest`). Macaque is
another. Either way there's one Safari extension to install; there just isn't one
to write.

### Metadata block

```javascript
// ==UserScript==
// @name         ytdistill
// @match        https://www.youtube.com/watch*
// @match        https://m.youtube.com/watch*
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.anthropic.com
// @connect      sponsor.ajay.app
// @connect      i.ytimg.com
// @run-at       document-idle
// ==/UserScript==
```

The specific directives shown are illustrative, not normative — `@match` vs the
regex `@include` we use elsewhere, and the promise-style `GM.*` vs Tampermonkey's
`GM_*` namespace, should follow the idioms already used by the other scripts in
this repo. What is load-bearing, whatever the spellings, is the substance of two
of these lines:

- **Inject into an isolated content world, not the page** (`@inject-into content`
  in quoid; Tampermonkey isolates by default). In page context, YouTube's own
  JavaScript can read your API key out of the script's scope. Isolation prevents
  it. This is the main security difference from a native extension.
- **Use the manager's privileged HTTP API, not `fetch`** (`GM.xmlHttpRequest` /
  `GM_xmlhttpRequest`). YouTube's CSP blocks direct cross-origin requests from the
  page; the GM request runs in the manager's privileged context and bypasses both
  CSP and CORS. Every external host needs a matching `@connect`.

### Key handling

- Store via `GM.setValue`, never in the script body — the script stays editable
  and shareable, the key survives edits.
- First run: no key → the injected button opens a small prompt to paste one.
- **Use a key with a hard spend cap.** At fractions of a cent per video, cap it
  at a few dollars a month and the worst case is fully bounded.
- Anthropic's API specifically requires
  `anthropic-dangerous-direct-browser-access: true` for browser-origin calls.
  The header name is warning about key exposure, which `@inject-into content`
  addresses — but the spend cap is the real backstop.

### Flow

```
page load / SPA navigation
  → inject button next to the video title
  → on click:
       read ytInitialPlayerResponse
       pick caption track (manual > ASR, preferred lang)
       GM.xmlHttpRequest the track baseUrl with &fmt=json3
       dedupe + timestamp cues
       GM.xmlHttpRequest SponsorBlock, cut segments
       probe thumbnails
       assemble prompt, GM.xmlHttpRequest the model
       validate against the contract
       render overlay
```

**Reading `ytInitialPlayerResponse`.** In content context you're isolated from
page JS, so read the serialised copy out of the `<script>` tag text rather than
touching `window`. Regex to the opening brace, then a brace-matching scan —
naïve greedy matching breaks on nested strings.

Caption track lives at
`captions.playerCaptionsTracklistRenderer.captionTracks[]`. `&fmt=json3` on the
`baseUrl` gives cleaner cue data than the default XML. Title, channel, duration,
description, chapters and the official thumbnail set all come from the same
object.

**SPA navigation.** YouTube doesn't reload between videos. Watch for
`yt-navigate-finish`, or a `MutationObserver` on the title, and re-inject. This
is the most common way userscripts on YouTube silently stop working.

### UI

No browser action is available to a userscript, so inject your own control. A
button beside the video title is better placed than one in the browser chrome
anyway.

Overlay, visually parallel to Safari Reader — full-page, generous type, original
page still loaded underneath, second press dismisses:

- Title, channel, duration, and a "~22s read vs 10:12 watch" line.
- `payload` in large type, immediately, above the fold. For a tease video this
  sentence is the entire reason the tool exists — nothing goes above it.
- Thumbnail strip below, horizontally scrollable, click for full size.
- `points` as a numbered list with clickable timestamps that seek the underlying
  player (`document.querySelector('video').currentTime = t`) and dismiss the
  overlay — for when the summary makes you want the one segment that matters.
- `notes`, then `gaps` in a visually quieter block.

Implementation: shadow DOM to escape YouTube's CSS, `position: fixed` at high
z-index, `prefers-color-scheme` respected, Escape to dismiss, pause the video on
open. Cache by video ID in `GM.setValue` so a re-toggle is instant; cap the cache
and expire it.

On iOS the same overlay needs to work at phone width and with touch targets —
worth checking early, since it's the platform you'll actually use it on most.

### Structure

Single-file distribution, but develop as modules and bundle:

```
userscript/
  src/
    main.js          # button injection, SPA nav handling, orchestration
    player.js        # ytInitialPlayerResponse extraction
    captions.js      # track selection, json3 parse, rolling-window dedupe
    sponsorblock.js
    thumbs.js
    distill.js       # prompt assembly + GM.xmlHttpRequest to the model
    overlay.js       # shadow DOM UI
    contract.js      # validation
  prompts/distill.md # symlinked or copied from the Python side
  build.mjs          # esbuild → ytdistill.user.js with metadata banner
```

Keep `captions.js` and the Python `captions.py` deliberately in lockstep — same
test videos, same expected output. Divergence there is the thing most likely to
make the two produce different summaries for the same video.

---

## 5. Phase 3 — native extension (optional)

Only worth building for the properties the userscript can't have: fully
on-device, offline, no key, nothing leaving the machine.

The port is mechanical. `player.js`, `captions.js`, `sponsorblock.js`,
`thumbs.js` and `overlay.js` move across essentially verbatim into a Safari Web
Extension's content script. What changes:

- `GM.xmlHttpRequest` → plain `fetch` from the content script, which carries the
  page's own credentials and origin (an improvement — no `@connect` list).
- `GM.getValue`/`setValue` → `browser.storage.local`.
- The injected button → a real MV3 toolbar action, or keep the in-page button.
- `distill.js` → a native messaging call through `SafariWebExtensionHandler.swift`
  into `FoundationModels`.

### The on-device constraint

Use `@Generable` structs mirroring the shared contract so guided generation
enforces the schema.

**Context window is the whole design problem.** On iOS/macOS 26 the on-device
model has a hard 4096-token session limit covering instructions, prompt and
response together. iOS/macOS 27 ships AFM 3 (a 3B dense "Core" tier and a 20B
sparse "Core Advanced" tier gated on newer hardware) with a larger but
unpublished on-device budget; the Private Cloud Compute server model is 32k.

So **do not hardcode a limit.** Query `SystemLanguageModel.contextSize` and
`tokenCount(for:)` (added in 26.4) at runtime and budget against what the device
reports. Check `SystemLanguageModel.default.availability` first and degrade
gracefully — unsupported device, Apple Intelligence off, model still downloading.

**Map-reduce for anything that doesn't fit:**

- Split on chapter boundaries where present, else ~2-minute windows aligned to
  caption cue gaps.
- Pass 1 per chunk: extract candidate points and claims into a compact
  intermediate. **Fresh `LanguageModelSession` per chunk** — sessions are
  stateful and accumulate transcript, so reusing one is how you hit
  `exceededContextWindowSize` on chunk four.
- Pass 2: one session over the concatenated intermediates, running the real
  prompt, producing the contract.
- Catch `GenerationError.exceededContextWindowSize` at every call site and retry
  with a tighter budget rather than failing the run.

Use `streamResponse` so the overlay fills progressively.

**Open question that should be tested before committing to this phase:** does a
3B on-device model do tease-detection reliably? If not, classification needs to
be its own pass, and the on-device prompt diverges from the cloud one — which is
much cheaper to discover with a throwaway test app than at the end of a port.

---

## 6. Practical notes

- **No accumulation.** Cache summaries and transcripts locally, keyed by video
  ID, with expiry. Don't build a searchable archive of other people's
  transcripts — that's what turns a private tool into a target.
- **ToS.** YouTube's terms prohibit access by means other than the API or the
  embedded player. Reading captions from a page you loaded in your own browser
  session is the least abrasive available path, and it's what both phase 2 and
  phase 3 do. Low-volume personal use is generally tolerated; the realistic
  downside is a throttle, not a lawyer.
- **Copyright.** Captions are protected as part of the AV work, but facts and
  ideas aren't, and a paragraph generated for yourself and never published isn't
  a market substitute. Australian fair dealing is narrower than US fair use;
  research/study is the applicable purpose. Private, non-distributed, nothing
  retained is about as low-risk as this gets. Publishing summaries or building a
  public service is where that changes.
- **Cloud LLM in phase 2** means transcripts leave the device. Fine for public
  YouTube content under any provider's commercial terms; it's the one property
  phase 3 exists to fix.
- **Expect caption-layer breakage.** Isolate it behind one interface in each
  codebase so a YouTube-side change is a one-file fix.

---

## 7. Milestones

**Phase 1**

1. Python: metadata + captions + cleanup → dump text. Verify the dedupe on a
   dozen videos. **No LLM yet.**
2. Python: prompt + contract + terminal render. Iterate against the cached corpus
   until tease-detection and listicle extraction are reliable. This is the
   longest phase and the one that determines whether the tool is any good.
3. Python: SponsorBlock, thumbnails, HTML render.

**Phase 2**

4. Userscript skeleton: metadata block, button injection, SPA nav handling.
   Log the video ID on click. Confirm it survives navigation.
5. Caption extraction + dedupe in JS. Diff against Python output for the same
   test videos until they match.
6. Key storage, `GM.xmlHttpRequest` to the model, contract validation, plain-text
   result in an `alert()`. Ugly but end-to-end.
7. SponsorBlock + thumbnails.
8. The overlay. Then the same overlay checked at phone width on iOS.

**Phase 3 (optional)**

9. Throwaway test: does the on-device model classify teases correctly?
10. If yes — extension scaffold, port the content scripts, native bridge,
    map-reduce, streaming.

## 8. Open questions

- Shared caption-cleanup core across Python and JS, or accept the duplication and
  keep them honest with a shared test corpus?
- Chapter data is often better than anything the model infers. Should enumerated
  chapters short-circuit listicle extraction entirely?
- Is `hq1/hq2/hq3` frame collection actually useful in practice, or noise? Cheap
  to test in phase 1, and it determines how much overlay real estate the
  thumbnail strip deserves.
