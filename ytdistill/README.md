# ytdistill (Phase 1 — Python CLI)

Turn a 10-minute YouTube video into the paragraph it should have been.

This is **Phase 1** of the [design doc](../ytdistill-design.md): a Python CLI that
is (a) the prompt-tuning harness and (b) the reference transcript pipeline the
Phase 2 userscript gets diffed against. It is a happy-path proof of concept —
the video is assumed to have captions, and the product-y edges (Whisper
fallback, thumbnail frame-probing, robust error UX) are deliberately deferred.

## Install

```bash
cd ytdistill
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # or: pip install -e .
export OPENAI_API_KEY=sk-...              # default provider; ANTHROPIC_API_KEY for --provider anthropic
```

`yt-dlp` also needs `ffmpeg` on PATH for some videos.

## Use

```bash
python -m ytdistill <url|id>                       # terminal summary
python -m ytdistill <url|id> --json out.json       # contract JSON
python -m ytdistill <url|id> --html out.html       # single-file HTML w/ deep links
python -m ytdistill <url|id> --review review.html  # summary + transcript + JSON
python -m ytdistill <url|id> --save-run            # bundle for adversarial eval
```

Flags: `--provider` (`openai` default, or `anthropic`), `--model` (defaults
`gpt-4.1` / `claude-opus-5`; `gpt-4o`/`-mini` cheaper, `gpt-5` more capable),
`--lang`, `--no-thumbs`, `--no-sponsorblock`, `--save-transcript`,
`--refresh` (re-pull, ignore cache), `--api-key`.

Everything pulled from YouTube — metadata, captions, SponsorBlock — is cached
under `~/.ytdistill/cache/<id>/`, so re-runs (prompt iteration, the compare loop)
skip the network entirely and can't get rate-limited. **Model output is cached
too**, keyed by a hash of prompt + transcript + model, so re-running an unchanged
video is free and instant (a prompt edit changes the key and re-runs) — which
makes retrying a rate-limited corpus cost nothing for the videos already done.
`--refresh` forces a fresh pull and re-distill. Outputs cache under `runs/` and
`transcripts/`. Override the root with `YTDISTILL_HOME`.

## Pipeline

`fetch` (yt-dlp metadata + captions) → `sponsorblock` (drop sponsor cues) →
`captions` (rolling-window dedupe + `[mm:ss]` markers) → `thumbs` → `distill`
(one structured-output Claude call, system prompt cached) → validate against the
`Summary` contract → `render`.

The system prompt — the actual product — is `ytdistill/prompts/distill.md`, the
single source of truth Phase 2 will embed.

## Evaluation: dual distillation, compared

Phase 1 exists to answer *"is the output any good?"* The workflow is a head-to-head:

1. **`make corpus`** runs every YouTube URL/id listed in
   [`eval/corpus.md`](eval/corpus.md) through the pipeline, so the **cloud model
   (OpenAI)** distills each into `~/.ytdistill/runs/<id>/`.
2. **Claude Code distills the same transcripts independently** (same
   `prompts/distill.md`) and **compares both against
   [`eval/rubric.md`](eval/rubric.md)** — agreement is confidence, divergence is
   the signal. You tie-break.
3. **`--review out.html`** (or `make review URL=…`) is the quick eyeball: the
   summary, the exact transcript, and the contract JSON on one page.

`corpus.md` is just a list of YouTube URLs/ids — drop them in, no schema.

## Deep-linked timestamps

Grounded `at_s` values (on `points` and `tease`) render as
`watch?v=…&t=Ns` links, so the summary doubles as a table of contents into the
one segment that matters. Extending this to `notes` is a tracked stretch goal
(design doc §1).

## Test

```bash
python3 tests/test_captions.py     # rolling-window dedupe, markers, VTT parse
```

## Layout

```
ytdistill/
  ytdistill/
    __main__.py     CLI + orchestration
    fetch.py        yt-dlp metadata + captions  (isolate caption breakage here)
    captions.py     VTT parse, rolling-window dedupe, [mm:ss] markers
    sponsorblock.py
    thumbs.py
    distill.py      prompt assembly + Claude call
    models.py       pydantic == the shared contract
    render.py       terminal / HTML / review
    prompts/distill.md
  eval/rubric.md          the dual-distillation compare rubric
  eval/corpus.md          list of YouTube URLs (you fill it)
  eval/run_corpus.py      batch the corpus through the pipeline
  Makefile                make help
  tests/test_captions.py
```

## Not in the PoC (Phase 1 follow-ups)

- Whisper fallback for videos with no captions.
- Thumbnail frame-probing (`hq1/hq2/hq3`) + perceptual-hash dedupe.
- Contract change to carry `at_s` on `notes`.
```
