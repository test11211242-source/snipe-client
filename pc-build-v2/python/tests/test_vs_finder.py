from __future__ import annotations

import numpy as np
import pytest

from geometry.vs_finder import MATCH_T, NORM_C, NORM_W, VSConfirmer, normalize_game, search
from synthetic_frames import arena, variants


@pytest.mark.parametrize("k", [.16, .21, .26])
@pytest.mark.parametrize("variant", ["original", "gray", "hue", "inverse"])
def test_colour_free_search(k: float, variant: str) -> None:
    # R§4.2: the 0.16 badge is the 3:4 layout, not the 9:16 phone layout.
    width, height = (480, 640) if k == .16 else (360, 640)
    image, badge = arena(width=width, height=height, k=k)
    image = variants(image)[variant]
    candidate = search(image, (0, 0, width, height))
    assert candidate is not None
    assert candidate.score >= MATCH_T
    assert candidate.cx == pytest.approx(badge.cx, abs=.006)
    assert candidate.cy == pytest.approx(badge.cy, abs=.004)
    assert candidate.badge.width == pytest.approx(badge.width, abs=.01)


def test_random_arena_is_not_a_vs_candidate() -> None:
    image, _ = arena(badge=False)
    candidate = search(image, (0, 0, 360, 640))
    assert candidate is None or candidate.score < .6


def test_confirmation_requires_three_and_an_empty_prior_frame() -> None:
    before, _ = arena(badge=False)
    image, _ = arena()
    rect = (0, 0, 360, 640)
    candidate = search(image, rect)
    assert candidate is not None
    confirmer = VSConfirmer()
    assert not confirmer.update(before, rect, search(before, rect))
    assert not confirmer.update(image, rect, candidate)
    assert not confirmer.update(image, rect, candidate)
    assert confirmer.update(image, rect, candidate)
    occupied = VSConfirmer()
    assert not any(occupied.update(image, rect, candidate) for _ in range(35))


def test_candidate_gap_resets_confirmation() -> None:
    before, _ = arena(badge=False)
    image, _ = arena()
    rect = (0, 0, 360, 640)
    candidate = search(image, rect)
    confirmer = VSConfirmer()
    confirmer.update(before, rect, None)
    confirmer.update(image, rect, candidate)
    confirmer.update(image, rect, None)
    assert not confirmer.update(image, rect, candidate)
    assert not confirmer.update(image, rect, candidate)
    assert confirmer.update(image, rect, candidate)


def test_external_pre_finder_history_confirms_despite_normalized_height_drift():
    before, _ = arena(480, 640, badge=False)
    image, _ = arena(480, 640)
    rect = (0, 0, 480, 640)
    candidate = search(image, rect)
    assert candidate is not None and candidate.score >= MATCH_T
    history = [normalize_game(before, rect)]
    confirmer = VSConfirmer(history_frames=15)
    for index, height in enumerate((640, 639, 640)):
        current_rect = (0, 0, 480, height)
        game = normalize_game(image, current_rect)
        assert confirmer.update(image, current_rect, candidate, game=game, before_games=history) == (index == 2)
    assert len(confirmer._history) == 0
    # Even external evidence cannot carry a consecutive run across source resize.
    larger = np.pad(image, ((0, 1), (0, 0), (0, 0)))
    assert not confirmer.update(larger, rect, candidate, before_games=history)


def test_search_and_confirmation_reuse_supplied_normalized_game(monkeypatch):
    import geometry.vs_finder as finder

    image, _ = arena()
    rect = (0, 0, 360, 640)
    game = normalize_game(image, rect)
    original_normalize = finder.normalize_game
    widths = []

    def counted_normalize(frame, game_rect, width=NORM_W):
        widths.append(width)
        return original_normalize(frame, game_rect, width)

    monkeypatch.setattr(finder, "normalize_game", counted_normalize)
    candidate = search(image, rect, game=game)
    assert candidate is not None and candidate.score >= MATCH_T
    assert widths == [NORM_C]
    assert not VSConfirmer().update(image, rect, candidate, game=game)
    assert widths == [NORM_C]
