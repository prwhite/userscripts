"""ytdistill — turn a 10-minute YouTube video into the paragraph it should have been.

Phase 1 (this package): a Python CLI that fetches captions, cleans them, and
runs a single structured-output LLM call to produce the shared contract. It is
the prompt-tuning harness and the reference transcript pipeline the userscript
(phase 2) will be diffed against.
"""

__version__ = "0.1.0"
