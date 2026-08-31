"""Unit tests for the caption pipeline — the doc's "single most consequential
piece of plumbing." Pure stdlib; runnable directly:

    python3 tests/test_captions.py      # or: python3 -m pytest tests/
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ytdistill import captions as cap  # noqa: E402


def test_rolling_dedupe_collapses_doubling():
    cues = [
        (0.0, 1.0, "the quick"),
        (1.0, 2.0, "the quick brown fox"),
        (2.0, 3.0, "brown fox jumps over"),
        (3.0, 4.0, "jumps over the lazy dog"),
    ]
    words = cap.dedupe_rolling(cues)
    assert [w for w, _ in words] == [
        "the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog",
    ], words
    # each word keeps the start time of the cue that introduced it
    assert words[4] == ("jumps", 2.0), words[4]


def test_manual_flatten_keeps_legit_repeats():
    cues = [(0.0, 1.0, "no no"), (1.0, 2.0, "no no")]
    words = cap.flatten_cues(cues)
    assert [w for w, _ in words] == ["no", "no", "no", "no"], words


def test_transcript_markers_only_on_bucket_change():
    words = [("a", 0.0), ("b", 5.0), ("c", 31.0), ("d", 62.0)]
    txt = cap.to_transcript(words, interval_s=30)
    assert txt == "[00:00] a b [00:30] c [01:00] d", txt


def test_parse_vtt_strips_tags_and_settings():
    vtt = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:02.000\n"
        "Hello <c>world</c>\n\n"
        "00:00:02.000 --> 00:00:04.000 align:start position:0%\n"
        "<00:00:02.500>second line\n"
    )
    cues = cap.parse_vtt(vtt)
    assert len(cues) == 2, cues
    assert cues[0] == (0.0, 2.0, "Hello world"), cues[0]
    assert cues[1][0] == 2.0 and cues[1][2] == "second line", cues[1]


def test_clean_captions_auto_end_to_end():
    cues = [
        (0.0, 2.0, "welcome to"),
        (2.0, 4.0, "welcome to the show"),
        (30.0, 32.0, "the show today"),
    ]
    txt, words = cap.clean_captions(cues, "auto_captions")
    assert txt == "[00:00] welcome to the show [00:30] today", txt
    assert words[-1] == ("today", 30.0), words[-1]


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
