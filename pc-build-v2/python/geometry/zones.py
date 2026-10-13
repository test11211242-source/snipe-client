"""Game-relative badge geometry and the normal battle layout (§3.3)."""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Badge:
    cx: float
    cy: float
    width: float
    height: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class FractionRect:
    x: float
    y: float
    width: float
    height: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


def _clip(x0: float, y0: float, x1: float, y1: float) -> FractionRect:
    x0, y0, x1, y1 = (max(0.0, min(1.0, v)) for v in (x0, y0, x1, y1))
    return FractionRect(x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0))


# The in-game interface scales with the game height down to 9:16; narrower
# games (1080x2400) scale it with the width instead.
UI_ASPECT = 9 / 16
# Opponent name, clan and medals in the top-left corner during the battle, in
# interface units (the 9:16 game height); on spectate they sit below the
# played-cards strip.
TOP_LEFT_WIDTH = 0.28
TOP_LEFT_HEIGHT = 0.105
SPECTATE_TOP_LEFT_Y = 0.135


def layout_kind(badge: Badge) -> str | None:
    """Own battles (Trainer Cheddar included) and friend spectating differ in VS height."""
    if badge.cy >= 0.46:
        return "spectate"
    if 0.40 <= badge.cy:
        return "battle"
    return None


def regions(badge: Badge, aspect: float) -> dict[str, FractionRect]:
    cx, cy, w, h = badge.cx, badge.cy, badge.width, badge.height
    uh = w * aspect
    unit = min(1.0, aspect / UI_ASPECT)
    top = SPECTATE_TOP_LEFT_Y * unit if layout_kind(badge) == "spectate" else 0.0
    return {
        "trigger": _clip(cx - w * 0.65, cy - h / 2 - 0.15 * uh, cx + w * 0.65, cy + h / 2 + 0.15 * uh),
        # Field test 1: from left of the name to just past the VS badge, the
        # name line and the clan/medals line below it (owner's target).
        "nickname": _clip(cx - 2.25 * w, cy - 1.50 * uh, cx + 0.87 * w, cy - 0.27 * uh),
        "topLeftEvidence": _clip(0.0, top, TOP_LEFT_WIDTH * unit / aspect, top + TOP_LEFT_HEIGHT * unit),
    }


def layout_rejection(badge: Badge, aspect: float) -> str | None:
    if badge.cy >= 0.46:
        return "SPECTATE_LIKE"
    if not 0.40 <= badge.cy < 0.46 or not 0.46 <= badge.cx <= 0.53:
        return "LAYOUT_UNEXPECTED"
    nickname = regions(badge, aspect)["nickname"]
    if nickname.height < 0.5 * 0.98 * badge.width * aspect or badge.cx - 1.71 * badge.width < 0:
        return "NICKNAME_ZONE_CLIPPED"
    return None
