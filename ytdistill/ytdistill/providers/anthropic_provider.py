"""Anthropic provider — structured outputs via messages.parse, system prompt
cached with an explicit breakpoint (Anthropic caching is opt-in per block)."""

from __future__ import annotations

from ..models import LLMOutput


def run(system_prompt, user_content, *, model, api_key=None, max_tokens=8000):
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)  # None -> ANTHROPIC_API_KEY / ant profile

    response = client.messages.parse(
        model=model,
        max_tokens=max_tokens or 8000,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_content}],
        output_format=LLMOutput,
    )

    parsed = response.parsed_output
    if parsed is None:
        raise RuntimeError(
            f"Anthropic returned no parseable summary (stop_reason={response.stop_reason})."
        )

    usage = response.usage
    usage_dict = usage.model_dump() if usage is not None and hasattr(usage, "model_dump") else {}
    usage_dict.update(provider="anthropic", model=model)
    return parsed, usage_dict
