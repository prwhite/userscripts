"""LLM providers. Each module exposes:

    run(system_prompt, user_content, *, model, api_key=None, max_tokens=None)
        -> (LLMOutput, usage_dict)

adding a provider is a new `<name>_provider.py` plus an entry in
distill.DEFAULT_MODELS.
"""
