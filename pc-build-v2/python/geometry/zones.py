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


def regions(badge: Badge, aspect: float) -> dict[str, FractionRect]:
    cx, cy, w, h = badge.cx, badge.cy, badge.width, badge.height
    uh = w * aspect
    return {
        "trigger": _clip(cx - w * 0.65, cy - h / 2 - 0.15 * uh, cx + w * 0.65, cy + h / 2 + 0.15 * uh),
        "nickname": _clip(cx - 2.00 * w, cy - 1.30 * uh, cx + 2.20 * w, cy - 0.32 * uh),
        "topLeftEvidence": _clip(cx - 2.30 * w, cy - 2.70 * uh, cx - 0.40 * w, cy - 1.30 * uh),
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
