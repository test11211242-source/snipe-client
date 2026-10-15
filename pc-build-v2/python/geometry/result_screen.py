"""Per-frame readers for the end-of-battle result screen (predictions C3.b).

All positions are interface units (`shape_match.ui_unit`) of the M9 game
rectangle. The result «vs» is searched around the game centre; the crown
slots and the delta pill are offsets from the found «vs», so the reading
follows the layout wherever the game places it. Shape only, never colour.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from geometry.shape_match import (Crop, Match, ShapeTemplate, best_match, crop_units, game_center,
                                  orientation_field)
from prediction_values import MAX_CROWNS, SIGN_MINUS, SIGN_PLUS

ASSET = Path(__file__).resolve().parents[1] / "assets" / "result_screen_v1.json"

# Result «vs»: band around the game centre, (dx0, dx1, dy0, dy1) units.
VS_BAND = (-0.08, 0.09, -0.04, 0.12)
# Above it: where the «vs» rests (uy ≈ -0.134) or passes (-0.12 … -0.04) once
# the screen has shifted up after the last crown. Owner clips: the shifted
# «vs» scores 0.61-0.87 here for 0.12-0.97 s; before the shift (crowns
# landing included) this band scores <= 0.42.
VS_SHIFTED_BAND = (-0.08, 0.09, -0.24, -0.02)
VS_PX = 540
# First match fires the burst. Battle and «Match over» frames score <= 0.41
# on the owner's clips, the settled «vs» 0.68-0.86.
VS_FIRE_T = 0.60
# During the burst the «vs» counts as present (at its place) from this score.
VS_KEEP_T = 0.50

# Cushion crown slots, relative to the «vs» centre.
CROWN_ROWS = {"top": (-0.2535, -0.1085), "bottom": (0.0115, 0.1415)}
CROWN_SLOTS = ((-0.21, -0.072), (-0.072, 0.074), (0.074, 0.212))
CROWN_PAD = 0.02
CROWN_PX = 300
CROWN_SCALES = (0.9, 1.0, 1.1)
# Settled crown >= 0.58 (median 0.69), empty slot <= 0.22 on the owner's clips.
CROWN_T = 0.45

# Delta pill at the right end of the own banner, relative to the «vs» centre.
PILL_BOX = (0.09, 0.25, 0.15, 0.24)
PILL_PX = 480          # icon search
TEXT_PX = 1000         # glyphs next to the icon
# Icon template heights in units (pill medal ≈0.037, league badge ≈0.040).
PILL_ICON_UNITS = {"medal": 0.0375, "league": 0.040}
ICON_SCALES = (0.85, 0.95, 1.05, 1.15)
ICON_T = 0.50          # PoL icon (medal / league badge) in the pill
ICON_SEEN_T = 0.40     # something pill-like was on screen
# Sign: height of the leftmost glyph over the digit height.
PLUS_MIN = 0.50
MINUS_MAX = 0.36


@dataclass(frozen=True)
class ResultTemplates:
    vs: ShapeTemplate
    crown: ShapeTemplate
    medal: ShapeTemplate
    leagues: tuple[ShapeTemplate, ...]

    @classmethod
    def load(cls, path: Path = ASSET) -> "ResultTemplates":
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ResultTemplates":
        if value.get("version") != 1:
            raise ValueError("Unsupported result screen asset")
        items = {item["name"]: ShapeTemplate.from_dict(item) for item in value["templates"]}
        leagues = tuple(items[name] for name in sorted(items) if name.startswith("pill-league-"))
        return cls(items["result-vs"], items["crown"], items["pill-medal"], leagues)


@dataclass(frozen=True)
class VsHit:
    score: float
    x: float      # frame pixels
    y: float
    ux: float     # units from the game centre
    uy: float


def find_vs(frame: np.ndarray, rect, templates: ResultTemplates, band=VS_BAND) -> VsHit | None:
    crop = crop_units(frame, rect, game_center(rect), band, VS_PX)
    if crop is None:
        return None
    match = best_match(orientation_field(crop.image), templates.vs)
    if match.score < 0:
        return None
    x, y = crop.to_frame(match.x, match.y)
    cx, cy = game_center(rect)
    return VsHit(match.score, x, y, (x - cx) / crop.unit, (y - cy) / crop.unit)


def crown_scores(frame: np.ndarray, rect, vs: tuple[float, float], templates: ResultTemplates) -> dict[str, list[float]]:
    scores: dict[str, list[float]] = {}
    for row, (y0, y1) in CROWN_ROWS.items():
        values = []
        for x0, x1 in CROWN_SLOTS:
            crop = crop_units(frame, rect, vs, (x0 - CROWN_PAD, x1 + CROWN_PAD, y0 - CROWN_PAD, y1 + CROWN_PAD),
                              CROWN_PX)
            values.append(-1.0 if crop is None else
                          best_match(orientation_field(crop.image), templates.crown, CROWN_SCALES).score)
        scores[row] = values
    return scores


def count_crowns(scores: dict[str, list[float]]) -> dict[str, int]:
    return {row: min(MAX_CROWNS, sum(score >= CROWN_T for score in values)) for row, values in scores.items()}


@dataclass(frozen=True)
class PillReading:
    icon_score: float
    icon: str | None       # "medal" | "league" | None
    sign: str | None       # SIGN_PLUS | SIGN_MINUS | None
    ratio: float | None    # sign height / digit height (diagnostics)


def _text_mask(gray: np.ndarray) -> np.ndarray:
    norm = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    _, binary = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary > 0


def sign_from_mask(mask: np.ndarray) -> tuple[str | None, float | None]:
    """Classify the leftmost glyph of a bright text run by its height.

    A column's extent is the span of its bright pixels; the digits set the
    reference height. The sign runs from the first bright column until a gap,
    a column of digit height, or the first rise after its peak (the «+» arm
    falling back before the next digit).
    """
    columns = np.flatnonzero(mask.any(axis=0))
    if columns.size == 0:
        return None, None
    extent = np.zeros(mask.shape[1])
    for x in columns:
        rows = np.flatnonzero(mask[:, x])
        extent[x] = rows[-1] - rows[0] + 1
    digit = float(np.percentile(extent[columns], 90))
    if digit < 5:
        return None, None
    run = []
    x = int(columns[0])
    while x < mask.shape[1] and 0 < extent[x] < 0.75 * digit:
        run.append(extent[x])
        x += 1
    if not run:
        return None, None
    peak = int(np.argmax(run))
    end = next((j for j in range(peak + 1, len(run)) if run[j] > run[j - 1]), len(run))
    ratio = max(run[:end]) / digit
    if ratio >= PLUS_MIN:
        return SIGN_PLUS, ratio
    if ratio <= MINUS_MAX:
        return SIGN_MINUS, ratio
    return None, ratio


def _icon(values: np.ndarray, templates: ResultTemplates) -> tuple[str | None, Match]:
    medal = best_match(values, templates.medal, ICON_SCALES)
    league = max((best_match(values, template, ICON_SCALES) for template in templates.leagues),
                 key=lambda match: match.score, default=Match(-1.0, 0, 0, 1, 0, 0))
    if medal.score >= league.score:
        return "medal", medal
    return "league", league


def read_pill(frame: np.ndarray, rect, vs: tuple[float, float], templates: ResultTemplates) -> PillReading:
    crop: Crop | None = crop_units(frame, rect, vs, PILL_BOX, PILL_PX)
    if crop is None:
        return PillReading(-1.0, None, None, None)
    kind, icon = _icon(orientation_field(crop.image), templates)
    if icon.score < ICON_T:
        return PillReading(icon.score, None, None, None)
    # The glyphs are read from a finer crop next to the icon, in units.
    cx, cy = crop.to_frame(icon.x, icon.y)
    half_w, height = icon.width / 2 / PILL_PX, icon.height / PILL_PX
    if kind == "medal":
        # Ultimate Champion: medal, then the number to its right. The crop
        # overlaps the icon edge a little; parts touching that border are the
        # icon, not the sign, and are dropped.
        box = (0.75 * half_w, half_w + 1.8 * height, -0.45 * height, 0.30 * height)
    else:
        # Leagues 1-6: the number left of the badge [one owner still].
        box = (-half_w - 1.8 * height, -0.75 * half_w, -0.45 * height, 0.30 * height)
    text = crop_units(frame, rect, (cx, cy), box, TEXT_PX)
    if text is None:
        return PillReading(icon.score, kind, None, None)
    mask = _drop_border(_text_mask(cv2.cvtColor(text.image, cv2.COLOR_BGR2GRAY)),
                        "left" if kind == "medal" else "right")
    if kind == "league":
        mask = _last_run(mask, gap=max(2, round(0.15 * height * TEXT_PX)))
    sign, ratio = sign_from_mask(mask)
    return PillReading(icon.score, kind, sign, ratio)


def _drop_border(mask: np.ndarray, side: str) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    kept = mask.copy()
    for label in range(1, count):
        x, width = stats[label, cv2.CC_STAT_LEFT], stats[label, cv2.CC_STAT_WIDTH]
        if (side == "left" and x == 0) or (side == "right" and x + width == mask.shape[1]):
            kept[labels == label] = False
    return kept


def _last_run(mask: np.ndarray, gap: int) -> np.ndarray:
    """Keep the text run touching the right end (next to the badge); drop the
    nickname that may sit further left behind a wider gap."""
    columns = np.flatnonzero(mask.any(axis=0))
    if columns.size == 0:
        return mask
    start = int(columns[-1])
    for previous, current in zip(columns[::-1][1:], columns[::-1][:-1]):
        if current - previous > gap:
            break
        start = int(previous)
    kept = np.zeros_like(mask)
    kept[:, start:] = mask[:, start:]
    return kept
