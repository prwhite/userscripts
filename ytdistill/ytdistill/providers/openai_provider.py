"""OpenAI provider — structured outputs via the SDK's pydantic parse helper.

OpenAI caches long prompt prefixes automatically (no explicit breakpoint), so
the shared system prompt is cached across corpus runs for free.
"""

from __future__ import annotations

from ..models import LLMOutput


def run(system_prompt, user_content, *, model, api_key=None, max_tokens=None):
    import openai

    client = openai.OpenAI(api_key=api_key)  # None -> OPENAI_API_KEY
    # max_tokens is intentionally left to the API default: newer models rename it
    # to max_completion_tokens, and a bounded summary never needs a ceiling here.
    completion = client.beta.chat.completions.parse(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format=LLMOutput,
    )

    msg = completion.choices[0].message
    parsed = getattr(msg, "parsed", None)
    if parsed is None:
        refusal = getattr(msg, "refusal", None)
        raise RuntimeError(f"OpenAI returned no parsed output (refusal={refusal!r}).")

    usage = completion.usage
    usage_dict = usage.model_dump() if usage is not None and hasattr(usage, "model_dump") else {}
    usage_dict.update(provider="openai", model=model)
    return parsed, usage_dict
