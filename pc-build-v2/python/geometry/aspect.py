"""Shared game-aspect bounds, layout distinctness and the runtime match band."""

ASPECT_MIN = 9 / 22 * 0.97
ASPECT_MAX = 3 / 4 * 1.03
# Layouts of one profile must differ by more than this (setup, learning, wire).
ASPECT_TOL = 0.03
# A game arms the closest layout within this gap; learning starts only beyond
# it. The 1.5 % between the bands is hysteresis: MuMu F11 portrait (1864/1920
# rows, gap 1.0300) and window jitter (±1 px ≈ 0.05 %) arm the same layout
# every time instead of flipping between «same» and «new», and a game learned
# beyond the band is never refused as overlapping.
ASPECT_MATCH_TOL = 0.045
# A layout already armed for the current frame size stays armed up to this gap
# when no layout matches: the peel drops uniform game rows on some screens
# (owner F11 menu: 1847 of 1864 rows, +0.9 %) and regains them on others, so
# the measured aspect moves mid-session. The orientation trigger keeps scoring
# ≥ 0.94 up to a 6 % stretch or crop.
ASPECT_HOLD_TOL = 0.06


def aspect_gap(a: float, b: float) -> float:
    return max(a / b, b / a) - 1


def aspects_overlap(a: float, b: float) -> bool:
    return aspect_gap(a, b) <= ASPECT_TOL


def aspect_matches(aspect: float, layout_aspect: float) -> bool:
    return aspect_gap(aspect, layout_aspect) <= ASPECT_MATCH_TOL
