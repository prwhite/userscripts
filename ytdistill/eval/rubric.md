# Evaluation — dual distillation, compared

Two independent distillations of the **same cleaned transcript**:

1. **Cloud (OpenAI).** The pipeline's output — `~/.ytdistill/runs/<id>/summary.json`.
2. **Claude (this session).** Claude Code reads the same `transcript.txt`, applies
   the **same** system prompt (`ytdistill/prompts/distill.md`), and produces its
   own distillation.

Both are judged against the criteria below **and against each other**. Where they
agree, confidence is high; where they diverge, that's the signal — surface it.
Payton tie-breaks after this phase.

There is no human-curated answer key. Grounding is judged against the transcript
itself, and the two distillations against one another.

## Workflow

```
make corpus                 # OpenAI distills every video in corpus.md -> runs/<id>/
```

Then, in Claude Code, for each run: read `transcript.txt`, distill it
independently under `prompts/distill.md`, score both distillations on the rubric,
and report the divergences.

## Criteria (score each distillation 1–5; note who wins and why)

1. **Kind classification** — same `kind`? If they differ, which fits the transcript?
2. **Payload-first (tease)** — the withheld thing stated plainly up front; a video
   that never answers is called out, not paraphrased.
3. **Listicle completeness & order** — every item, in the video's order, with
   ranks; count mismatch flagged in `gaps`; nothing merged.
4. **Specificity preserved** — the creator's numbers, prices, versions, part
   names, not smoothed into paraphrase. Spot-check three against the transcript.
5. **Grounding / no fabrication** — every claim traces to the transcript; no
   imported world-knowledge. (Real failure mode: the Rick Astley smoke run had
   "1987 chart-topping hit / deep voice" in the payload, neither of which is in
   the captions.)
6. **Timestamp integrity** — each `at_s` / `answered_at_s` lands near the matching
   `[mm:ss]` marker; no fabricated jumps.
7. **Voice discipline** — no "the video discusses / explains / covers"; no
   narration of structure.
8. **Gaps honesty** — real omissions only; an empty `gaps` is valid.

## Output (per video)

- A short comparison: each criterion × {OpenAI, Claude} with a one-line note.
- **Verdict:** agree · OpenAI better · Claude better · both weak — plus the single
  most important divergence.
- If a divergence implicates the prompt, name the rule in `prompts/distill.md` to
  add or sharpen. Tuning the prompt against the fixed corpus is the whole point
  (design doc §7, milestone 2).
