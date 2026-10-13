"""Shared setup/learning acceptance without runtime or protocol policy (§3.7)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from geometry.game_rect import RectResult
from geometry.vs_orient_trigger import ORIENT_T, OrientationTrigger
from geometry.zones import Badge, layout_rejection


@dataclass(frozen=True)
class SelfCheck:
    min_vs: float
    max_before: float
    frames: int


@dataclass(frozen=True)
class Acceptance:
    code: str | None
    confidence: float | None = None
    self_check: SelfCheck | None = None

    @property
    def ok(self) -> bool:
        return self.code is None


def accept(game: RectResult, *, geometry_frames: int, confirmed: bool, badge: Badge | None,
           trigger: OrientationTrigger | None, before_scores: Sequence[float],
           vs_scores: Sequence[float]) -> Acceptance:
    """vs_scores starts with confirmation and includes ≥1 following frame.

    before_scores contains every buffered frame ≥1 s before VS onset. Empty sets
    cannot certify the measured margin. Codes deliberately have no AUTO_/LEARN_ prefix.
    """
    if game.reason == "aspect_out_of_range":
        return Acceptance("ASPECT_UNSUPPORTED")
    if game.rect is None or game.reason != "ok" or geometry_frames < 8:
        return Acceptance("GAME_NOT_FOUND")
    if not confirmed or badge is None:
        return Acceptance("VS_NOT_FOUND")
    code = layout_rejection(badge, game.aspect)
    if code:
        return Acceptance(code)
    if trigger is None or not 0.45 <= trigger.mask_area_ratio <= 0.70 or not trigger.contains_center:
        return Acceptance("TRIGGER_WEAK")
    if (len(vs_scores) < 2 or not before_scores or not all(np.isfinite(v) and v >= ORIENT_T for v in vs_scores)
            or not all(np.isfinite(v) and v < 0.30 for v in before_scores)):
        return Acceptance("SELF_CHECK_FAILED")
    minimum, maximum = min(vs_scores), max(before_scores)
    check = SelfCheck(minimum, maximum, len(vs_scores) + len(before_scores))
    return Acceptance(None, round(min(1.0, (minimum - maximum) / 0.6), 2), check)
