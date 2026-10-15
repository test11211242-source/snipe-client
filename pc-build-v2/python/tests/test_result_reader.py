from __future__ import annotations

import numpy as np
import pytest

import result_reader as rr
from geometry.result_screen import PillReading, VsHit
from result_reader import ResultReader, _Sample, decide


def samples(*rows) -> list[_Sample]:
    return [_Sample(round(0.1 * index, 1), top, bottom, icon, sign)
            for index, (top, bottom, icon, sign) in enumerate(rows)]


def test_pill_sign_decides_and_crowns_cross_check() -> None:
    rows = [(0, 0, False, None)] * 4 + [(0, 0, True, "-")] * 6 + [(1, 0, True, "-")] * 4
    report = decide(samples(*rows), elapsed=1.5, pill_seen=True)
    assert report == {"outcome": "loss", "evidence": {"crowns": {"top": 1, "bottom": 0}, "deltaSign": "-",
                                                      "deltaIcon": "pol"}}


def test_a_single_sign_sample_is_not_confirmed() -> None:
    rows = [(0, 0, True, "+"), (0, 0, True, None), (0, 0, True, "+"), (0, 0, True, None)]
    report = decide(samples(*rows), elapsed=0.5, pill_seen=True)
    assert report["evidence"]["deltaSign"] is None and report["outcome"] == "unknown"


def test_both_signs_confirmed_is_unknown() -> None:
    rows = [(0, 0, True, "+")] * 2 + [(0, 0, True, "-")] * 2
    assert decide(samples(*rows), elapsed=0.5, pill_seen=True)["outcome"] == "unknown"


def test_crowns_contradicting_the_sign_give_unknown() -> None:
    rows = [(0, 0, True, "+")] * 4 + [(2, 1, True, "+")] * 3
    assert decide(samples(*rows), elapsed=1.6, pill_seen=True)["outcome"] == "unknown"


def test_equal_final_counts_with_minus_is_a_draw() -> None:
    rows = [(0, 0, True, "-")] * 6 + [(1, 0, True, "-")] * 3 + [(1, 1, True, "-")] * 3
    assert decide(samples(*rows), elapsed=1.6, pill_seen=True)["outcome"] == "draw"


def test_early_end_never_confirms_counts() -> None:
    # Skipped before the crowns could drop: 0:0 must not read as a draw.
    rows = [(0, 0, True, "-")] * 8
    report = decide(samples(*rows), elapsed=0.8, pill_seen=True)
    assert report["evidence"]["crowns"] == {"top": None, "bottom": None}
    assert report["outcome"] == "loss"


def test_landing_flicker_is_tolerated_but_held_decrease_is_not() -> None:
    flicker = [(0, 0, True, "+")] * 5 + [(0, 1, True, "+"), (0, 0, True, "+")] + [(0, 1, True, "+")] * 3
    assert decide(samples(*flicker), elapsed=1.2, pill_seen=True)["evidence"]["crowns"] == {"top": 0, "bottom": 1}
    decrease = [(0, 2, True, "+")] * 3 + [(0, 1, True, "+")] * 3
    assert decide(samples(*decrease), elapsed=1.2, pill_seen=True)["evidence"]["crowns"] == {"top": None,
                                                                                              "bottom": None}


@pytest.mark.parametrize("elapsed,seen,icon", [(1.5, False, "absent"), (0.5, False, "unreadable"),
                                               (1.5, True, "unreadable")])
def test_pill_icon_absent_or_unreadable(elapsed, seen, icon) -> None:
    rows = [(0, 1, False, None)] * 3
    report = decide(samples(*rows), elapsed=elapsed, pill_seen=seen)
    assert report["evidence"]["deltaIcon"] == icon and report["evidence"]["deltaSign"] is None


class Screen:
    """Scripted per-tick readings for the reader (no pixels)."""

    def __init__(self, monkeypatch):
        self.vs: dict[float, tuple[float, float] | None] = {}
        self.calls = 0
        monkeypatch.setattr(rr, "find_vs", self.find_vs)
        monkeypatch.setattr(rr, "crown_scores", lambda frame, rect, vs, t: {"top": [0.8, 0, 0], "bottom": [0, 0, 0]})
        monkeypatch.setattr(rr, "read_pill", lambda frame, rect, vs, t: PillReading(0.8, "medal", "-", 0.25))
        self.now = 0.0

    def find_vs(self, frame, rect, templates):
        self.calls += 1
        value = self.vs.get(round(self.now, 1))
        if value is None:
            return VsHit(0.2, 0, 0, 0, 0)
        score, uy = value
        return VsHit(score, 540, 760 + uy * 1520, 0, uy)


def run(reader: ResultReader, screen: Screen, start: float, stop: float, rect=(0, 0, 1080, 1520)):
    frame = np.zeros((4, 4, 3), np.uint8)
    reports = []
    t = start
    while t <= stop + 1e-9:
        screen.now = t
        report = reader.process(frame, rect, t)
        if report is not None:
            reports.append((round(t, 1), report, reader.diagnostics["endReason"]))
        t = round(t + 0.1, 1)
    return reports


def test_idle_reader_does_nothing_until_armed_window(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    assert run(reader, screen, 0, 1) == [] and screen.calls == 0
    reader.arm(0.0)
    screen.vs = {round(t / 10, 1): (0.9, 0.02) for t in range(0, 300)}
    assert run(reader, screen, 0.1, 19.9) == [] and screen.calls == 0     # nothing within 20 s of the VS


def test_burst_reads_until_the_shift_then_disarms(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 16)}
    screen.vs[31.6] = (0.8, 0.01)                                         # moved up: the shift
    reports = run(reader, screen, 29.0, 40.0)
    assert len(reports) == 1
    t, report, reason = reports[0]
    assert (t, reason) == (31.6, "shift")
    assert report == {"outcome": "loss", "evidence": {"crowns": {"top": 1, "bottom": 0}, "deltaSign": "-",
                                                      "deltaIcon": "pol"}}
    assert not reader.armed
    assert reader.diagnostics["trace"][-1][0] == 1.5                      # last read before the shift


def test_hidden_vs_is_not_read_and_ends_after_missing_time(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 12)}
    for t in (30.5, 30.6, 30.7):                                          # a crown over the glyph
        screen.vs[t] = None
    reports = run(reader, screen, 30.0, 33.0)
    (t, report, reason), = reports
    assert reason == "vs_lost" and t == pytest.approx(31.2 + rr.MISSING_S)
    assert [row[0] for row in reader.diagnostics["trace"]] == [0.0, 0.1, 0.2, 0.3, 0.4, 0.8, 0.9, 1.0, 1.1]


def test_burst_is_capped(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 60)}
    (t, _, reason), = run(reader, screen, 30.0, 35.0)
    assert reason == "cap" and t == pytest.approx(30 + rr.BURST_CAP_S)


def test_missing_game_and_capture_end(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {30.0: (0.85, 0.024), 30.1: (0.85, 0.024)}
    run(reader, screen, 30.0, 30.1)
    report = reader.finish(30.2)
    assert report["evidence"] == {"crowns": {"top": None, "bottom": None}, "deltaSign": "-", "deltaIcon": "pol"}
    assert reader.diagnostics["endReason"] == "capture_end" and reader.finish(30.3) is None


def test_arm_window_expires(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0)
    screen.now = rr.ARM_WINDOW_S + 1
    assert reader.process(np.zeros((4, 4, 3), np.uint8), (0, 0, 4, 4), rr.ARM_WINDOW_S + 1) is None
    assert not reader.armed


@pytest.mark.replay
def test_c3_owner_replay(tmp_path):
    import os
    from pathlib import Path

    from tools.c3_replay import c3_replay
    manifest = os.environ.get("CR_C3_REPLAY_MANIFEST")
    if not manifest:
        pytest.skip("Set CR_C3_REPLAY_MANIFEST to the external C3 recording manifest")
    assert c3_replay(Path(manifest), tmp_path)["acceptance"]["passed"]
