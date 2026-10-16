"""VS rank check (predictions C3.a): is the battle Path of Legends?

Runs once on the own-battle VS trigger frame. Each nickname has a rank line
right under it: Ultimate Champion shows a medal icon (+ league-7 badge and a
number), leagues 1-6 a lone league badge, other modes nothing or a trophy cup.
Only the icon slot band is searched, so banner-corner decorations and the VS
shield stay outside. Shape only (edge orientation), never colour.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from geometry.shape_match import ShapeTemplate, best_match, crop_units, orientation_field, ui_unit
from geometry.zones import Badge, regions
from prediction_values import (LINE_EMPTY, LINE_LEAGUE, LINE_MEDAL, LINE_UNKNOWN, RANK_UNKNOWN,
                               rank_from_lines)

ASSET = Path(__file__).resolve().parents[1] / "assets" / "pol_rank_v1.json"
RANK_PX = 550
# Template heights in pixels at RANK_PX (icon heights on the owner's VS
# clips: league badge ≈0.055 units, medal ≈0.045 units).
RANK_TEMPLATE_HEIGHTS = {"league": round(0.055 * RANK_PX), "medal": round(0.045 * RANK_PX)}
RANK_SCALES = (0.9, 1.0, 1.1)

# Opponent: lower 60 % of the M9 nickname zone (dataset run), and only its
# left part: the icons start the line (badge, medal, then the number).
OPPONENT_X = (0.0, 0.45)
OPPONENT_Y = (0.40, 1.0)
# Own line: mirrored about the badge centre; below the own name, in
# badge-height units uh = badge.width × aspect. Centred on the rank icons of
# the bottom player on the spectate clips (icon centre 3.33-3.34 uh, icon
# ≈0.45 uh tall), so the line may sit ±0.1 uh off and still be read. Own-battle
# VS (5 Cheddar recordings, 4 formats) shows the own name at the same offset
# as the spectate bottom name (≈3.0 uh) within that slack; no own PoL VS has
# been recorded yet (review M-10).
OWN_Y = (3.00, 3.65)
# Owner VS clips at RANK_PX: medal lines 0.78+, league lines 0.80+; lines
# without a rank icon reach medal 0.52 / league 0.53 (name glyphs, sparkles,
# the Ultimate Champion league-7 badge against leagues 1-6).
MEDAL_T = 0.68
LEAGUE_T = 0.62
# Between these and the thresholds the line is unreadable, not empty.
MEDAL_UNSURE = 0.60
LEAGUE_UNSURE = 0.55
MARGIN = 0.05


@dataclass(frozen=True)
class RankTemplates:
    medal: ShapeTemplate
    leagues: tuple[ShapeTemplate, ...]     # leagues 1-6 decide; league-7 matches the game art poorly

    @classmethod
    def load(cls, path: Path = ASSET) -> "RankTemplates":
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RankTemplates":
        if value.get("version") != 1:
            raise ValueError("Unsupported rank asset")
        items = {item["name"]: ShapeTemplate.from_dict(item) for item in value["templates"]}
        return cls(items["rank-medal"], tuple(items[f"rank-league-{n}"] for n in range(1, 7)))


@dataclass(frozen=True)
class LineReading:
    line: str
    medal: float
    league: float


def zones(badge: Badge, aspect: float) -> dict[str, tuple[float, float, float, float]]:
    """Both rank-line zones as game fractions (x0, x1, y0, y1)."""
    nickname = regions(badge, aspect)["nickname"]
    x0 = nickname.x + OPPONENT_X[0] * nickname.width
    x1 = nickname.x + OPPONENT_X[1] * nickname.width
    y0 = nickname.y + OPPONENT_Y[0] * nickname.height
    y1 = nickname.y + OPPONENT_Y[1] * nickname.height
    uh = badge.width * aspect
    own_y0, own_y1 = badge.cy + OWN_Y[0] * uh, badge.cy + OWN_Y[1] * uh
    clip = lambda v: max(0.0, min(1.0, v))  # noqa: E731
    return {"opponent": (clip(x0), clip(x1), clip(y0), clip(y1)),
            "own": (clip(2 * badge.cx - x1), clip(2 * badge.cx - x0), clip(own_y0), clip(own_y1))}


def classify(medal: float, league: float) -> str:
    if medal >= MEDAL_T and medal >= league - MARGIN:
        return LINE_MEDAL
    if league >= LEAGUE_T and league >= medal + MARGIN:
        return LINE_LEAGUE
    if medal >= MEDAL_UNSURE or league >= LEAGUE_UNSURE:
        return LINE_UNKNOWN
    # No rank marker. A trophy cup scores below both (dataset: league <= 0.41,
    # medal <= 0.44) and means the same for the rank: not Path of Legends.
    return LINE_EMPTY


def read_line(frame: np.ndarray, rect, zone: tuple[float, float, float, float],
              templates: RankTemplates) -> LineReading:
    gx, gy, gw, gh = rect
    x0, x1, y0, y1 = zone
    unit = ui_unit(rect)
    origin = (gx + x0 * gw, gy + y0 * gh)
    box = (0.0, (x1 - x0) * gw / unit, 0.0, (y1 - y0) * gh / unit)
    crop = crop_units(frame, rect, origin, box, RANK_PX)
    if crop is None:
        return LineReading(LINE_UNKNOWN, -1.0, -1.0)
    values = orientation_field(crop.image)
    medal = best_match(values, templates.medal, RANK_SCALES).score
    # Leagues: pick the closest badge at the nominal size, then try its scales
    # (the six badges share the shield outline; this halves the matches).
    nominal = [best_match(values, template).score for template in templates.leagues]
    closest = templates.leagues[int(np.argmax(nominal))]
    others = tuple(scale for scale in RANK_SCALES if scale != 1.0)
    league = max(max(nominal), best_match(values, closest, others).score)
    return LineReading(classify(medal, league), medal, league)


def check_rank(frame: np.ndarray, rect, badge: Badge, templates: RankTemplates) -> dict[str, Any]:
    """`{"rank", "rankEvidence": {"opponent", "own"}}` for the `triggered` event."""
    aspect = rect[2] / rect[3]
    try:
        lines = {side: read_line(frame, rect, zone, templates).line for side, zone in zones(badge, aspect).items()}
    except (ValueError, IndexError):
        return {"rank": RANK_UNKNOWN, "rankEvidence": None}
    return {"rank": rank_from_lines(lines["opponent"], lines["own"]), "rankEvidence": lines}
