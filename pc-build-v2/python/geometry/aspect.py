"""Shared game-aspect bounds and symmetric layout-distinctness rule."""

ASPECT_MIN = 9 / 22 * 0.97
ASPECT_MAX = 3 / 4 * 1.03
ASPECT_TOL = 0.03


def aspects_overlap(a: float, b: float) -> bool:
    return max(a / b, b / a) - 1 <= ASPECT_TOL
