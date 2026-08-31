"""Prompt assembly + a single structured-output model call (design doc §3).

The provider is pluggable: `distill()` builds the prompt once and dispatches to
a provider module under `providers/`. Bring-up defaults to OpenAI; Anthropic is
supported by the same structured-output path. Each provider returns
(LLMOutput, usage_dict).
"""

from __future__ import annotations

import importlib
import importlib.resources

from . import cache
from .models import LLMOutput

DEFAULT_PROVIDER = "openai"
DEFAULT_MODELS = {
    "openai": "gpt-4.1",           # gpt-4o/-mini cheaper; gpt-5 more capable (better faithfulness)
    "anthropic": "claude-opus-5",  # try claude-sonnet-5 for cost
}
DEFAULT_MAX_TOKENS = 8000
_WORDS_PER_SECOND = 3.3  # ~200 wpm, for the read-time estimate


def load_system_prompt() -> str:
    return (
        importlib.resources.files("ytdistill").joinpath("prompts", "distill.md").read_text(encoding="utf-8")
    )


def _fmt_duration(seconds: int) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_user_content(meta: dict, transcript: str) -> str:
    """Assemble caller inputs in the order the prompt expects (design doc §2)."""
    parts = [
        f"Title: {meta['title']}",
        f"Channel: {meta['channel']}",
        f"Duration: {_fmt_duration(meta['duration_s'])}",
    ]
    desc = (meta.get("description") or "").strip()
    if desc:
        parts.append("Description (first 500 chars):\n" + desc[:500])
    chapters = meta.get("chapters") or []
    if chapters:
        lines = [
            f"- [{_fmt_duration(int(c.get('start_time', 0)))}] {c.get('title', '')}"
            for c in chapters
        ]
        parts.append("Chapters:\n" + "\n".join(lines))
    parts.append(
        "Transcript (machine-generated, [mm:ss] markers every ~30s):\n" + transcript
    )
    return "\n\n".join(parts)


def estimate_read_seconds(llm: LLMOutput) -> int:
    words = len(llm.payload.split())
    if llm.tease:
        words += len(llm.tease.answer.split())
    for p in llm.points:
        words += len(p.label.split()) + len(p.detail.split())
    for n in llm.notes:
        words += len(n.split())
    return max(5, round(words / _WORDS_PER_SECOND))


def distill(meta, transcript, provider=DEFAULT_PROVIDER, model=None, api_key=None,
            max_tokens=DEFAULT_MAX_TOKENS, use_cache=True):
    """One structured-output call via the chosen provider.

    Returns (LLMOutput, usage_dict). The model output is cached by a hash of
    provider+model+prompt+transcript, so re-running an unchanged video (e.g.
    retrying a corpus whose fetches were rate-limited) costs nothing; a prompt
    edit changes the key and re-runs.
    """
    provider = provider or DEFAULT_PROVIDER
    model = model or DEFAULT_MODELS.get(provider)
    if model is None:
        raise ValueError(f"Unknown provider {provider!r}; known: {', '.join(DEFAULT_MODELS)}")

    system_prompt = load_system_prompt()
    user_content = build_user_content(meta, transcript)

    key = cache.llm_key(provider, model, system_prompt, user_content)
    if use_cache:
        hit = cache.load_llm(key)
        if hit is not None:
            usage = dict(hit.get("usage") or {})
            usage["cached"] = True
            return LLMOutput.model_validate(hit["output"]), usage

    try:
        mod = importlib.import_module(f".providers.{provider}_provider", __package__)
    except ModuleNotFoundError:
        raise ValueError(f"Unknown provider {provider!r}; known: {', '.join(DEFAULT_MODELS)}")

    llm, usage = mod.run(system_prompt, user_content, model=model, api_key=api_key, max_tokens=max_tokens)
    if use_cache:
        cache.save_llm(key, {"output": llm.model_dump(), "usage": usage})
    return llm, usage
