"""The shared contract (design doc §1), as pydantic models.

`LLMOutput` is the analytical slice the model actually produces. `Summary` is
the full contract: the model's output merged with metadata we already hold
(ids, thumbnails, timings). Keeping them separate stops the model from
hallucinating a video id or a thumbnail set it was never given.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

VideoKind = Literal["tease", "listicle", "tutorial", "review", "narrative"]
ThumbRole = Literal["official", "auto", "storyboard"]
TranscriptSource = Literal["manual_captions", "auto_captions", "whisper"]


class Tease(BaseModel):
    question: str
    answer: str
    # Deep-linked timestamp (design doc §1 stretch goal): only present when the
    # answer can be grounded in a caption cue.
    answered_at_s: Optional[int] = None


class Point(BaseModel):
    rank: int
    label: str
    detail: str
    at_s: Optional[int] = None  # deep-linked moment; omitted if ungrounded


class Thumbnail(BaseModel):
    url: str
    w: int
    h: int
    role: ThumbRole


class LLMOutput(BaseModel):
    """What the model emits. No ids, thumbnails, or timings — those are ours."""

    kind: VideoKind
    payload: str
    tease: Optional[Tease] = None
    points: list[Point] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)


class Summary(BaseModel):
    """The full shared contract — what render/validate/cache all consume."""

    video_id: str
    title: str
    channel: str
    duration_s: int
    kind: VideoKind
    payload: str
    tease: Optional[Tease] = None
    points: list[Point] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    read_seconds: int
    watch_seconds: int
    thumbnails: list[Thumbnail] = Field(default_factory=list)
    transcript_source: TranscriptSource
    sponsor_segments_removed_s: int = 0

    @classmethod
    def from_llm(
        cls,
        llm: LLMOutput,
        meta: dict,
        thumbnails: list[Thumbnail],
        transcript_source: TranscriptSource,
        sponsor_removed_s: int,
        read_seconds: int,
    ) -> "Summary":
        return cls(
            video_id=meta["video_id"],
            title=meta["title"],
            channel=meta["channel"],
            duration_s=meta["duration_s"],
            kind=llm.kind,
            payload=llm.payload,
            tease=llm.tease,
            points=llm.points,
            notes=llm.notes,
            gaps=llm.gaps,
            read_seconds=read_seconds,
            watch_seconds=meta["duration_s"],
            thumbnails=thumbnails,
            transcript_source=transcript_source,
            sponsor_segments_removed_s=sponsor_removed_s,
        )
