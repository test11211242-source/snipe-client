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
    report = decide(samples(*rows), final=True, pill_seen=True)
    assert report == {"outcome": "loss", "evidence": {"crowns": {"top": 1, "bottom": 0}, "deltaSign": "-",
                                                      "deltaIcon": "pol"}}


def test_a_single_sign_sample_is_not_confirmed() -> None:
    rows = [(0, 0, True, "+"), (0, 0, True, None), (0, 0, True, "+"), (0, 0, True, None)]
    report = decide(samples(*rows), final=False, pill_seen=True)
    assert report["evidence"]["deltaSign"] is None and report["outcome"] == "unknown"


def test_both_signs_confirmed_is_unknown() -> None:
    rows = [(0, 0, True, "+")] * 2 + [(0, 0, True, "-")] * 2
    assert decide(samples(*rows), final=False, pill_seen=True)["outcome"] == "unknown"


def test_crowns_contradicting_the_sign_give_unknown() -> None:
    rows = [(0, 0, True, "+")] * 8 + [(2, 1, True, "+")] * 3
    assert decide(samples(*rows), final=True, pill_seen=True)["outcome"] == "unknown"


def test_equal_final_counts_with_minus_is_a_draw() -> None:
    rows = [(0, 0, True, "-")] * 6 + [(1, 0, True, "-")] * 3 + [(1, 1, True, "-")] * 3
    assert decide(samples(*rows), final=True, pill_seen=True)["outcome"] == "draw"


def test_early_end_never_confirms_counts() -> None:
    # Skipped before the crowns could drop: 0:0 must not read as a draw.
    rows = [(0, 0, True, "-")] * 8
    report = decide(samples(*rows), final=True, pill_seen=True)
    assert report["evidence"]["crowns"] == {"top": None, "bottom": None}
    assert report["outcome"] == "loss"


def test_landing_flicker_is_tolerated_but_held_decrease_is_not() -> None:
    flicker = [(0, 0, True, "+")] * 5 + [(0, 1, True, "+"), (0, 0, True, "+")] + [(0, 1, True, "+")] * 4
    assert decide(samples(*flicker), final=True, pill_seen=True)["evidence"]["crowns"] == {"top": 0, "bottom": 1}
    decrease = [(0, 2, True, "+")] * 6 + [(0, 1, True, "+")] * 5
    assert decide(samples(*decrease), final=True, pill_seen=True)["evidence"]["crowns"] == {"top": None,
                                                                                             "bottom": None}


@pytest.mark.parametrize("last_read", [0.4, 0.9, 1.5])
def test_counts_of_an_unfinished_read_are_never_a_draw(last_read) -> None:
    # Review M-8: the «vs» vanished (vs_lost/gap/capture end) before the shift
    # was seen, so a 1:1 read may be a 2:1 still landing.
    rows = [(0, 0, True, "-")] * 4 + [(1, 1, True, "-")] * (round(last_read * 10) - 3)
    report = decide(samples(*rows), final=False, pill_seen=True)
    assert report["evidence"]["crowns"] == {"top": None, "bottom": None}
    assert report["outcome"] == "loss"


@pytest.mark.parametrize("reads,seen,icon", [(10, False, "absent"), (5, False, "unreadable"),
                                             (10, True, "unreadable")])
def test_pill_icon_absent_or_unreadable(reads, seen, icon) -> None:
    # `absent` needs a last read at or after PILL_ABSENT_S, not just elapsed time.
    rows = [(0, 1, False, None)] * reads
    report = decide(samples(*rows), final=True, pill_seen=seen)
    assert report["evidence"]["deltaIcon"] == icon and report["evidence"]["deltaSign"] is None


class Screen:
    """Scripted per-tick readings for the reader (no pixels)."""

    def __init__(self, monkeypatch, crowns=((0.8, 0, 0), (0, 0, 0)), pill=PillReading(0.8, "medal", "-", 0.25)):
        self.vs: dict[float, tuple[float, float] | None] = {}
        self.shifted: dict[float, tuple[float, float]] = {}
        self.calls = 0
        monkeypatch.setattr(rr, "find_vs", self.find_vs)
        monkeypatch.setattr(rr, "crown_scores",
                            lambda frame, rect, vs, t: {"top": list(crowns[0]), "bottom": list(crowns[1])})
        monkeypatch.setattr(rr, "read_pill", lambda frame, rect, vs, t: pill)
        self.now = 0.0

    def find_vs(self, frame, rect, templates, band=None):
        if band is rr.VS_SHIFTED_BAND:
            value = self.shifted.get(round(self.now, 1), (0.3, -0.13))
        else:
            self.calls += 1
            value = self.vs.get(round(self.now, 1))
        if value is None:
            return VsHit(0.2, 0, 0, 0, 0)
        score, uy = value
        return VsHit(score, 540, 760 + uy * 1520, 0, uy)


@pytest.mark.parametrize("score,icon", [
    (0.46, "absent"),       # highest pill-box score before a PoL pill appears (owner clips)
    (0.56, "unreadable"),   # something pill-like but no PoL icon: a trophy pill, say
])
def test_a_pill_without_a_pol_icon_is_never_read_as_a_pol_result(monkeypatch, score, icon) -> None:
    # Review M-9: no trophy template. Such a screen may read `absent` (a
    # `not_pol` VS then counts as not ranked) or `unreadable`, never pol + sign.
    screen = Screen(monkeypatch, pill=PillReading(score, None, None, None))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 16)}
    screen.vs[31.6] = (0.8, 0.01)
    (_, report, reason), = run(reader, screen, 30.0, 33.0)
    assert reason == "shift"
    assert report == {"outcome": "unknown", "evidence": {"crowns": {"top": 1, "bottom": 0}, "deltaSign": None,
                                                         "deltaIcon": icon}}


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


@pytest.mark.parametrize("score,pill_icon,expected_icon", [
    (0.46, None, "absent"), (0.56, None, "unreadable"), (0.8, "medal", "pol"),
])
@pytest.mark.parametrize("top,bottom,outcome", [(0, 1, "win"), (1, 0, "loss")])
@pytest.mark.parametrize("ending", ["shift", "cap"])
def test_ranked_reader_without_sign_uses_only_settled_crowns(
        monkeypatch, score, pill_icon, expected_icon, top, bottom, outcome, ending) -> None:
    screen = Screen(monkeypatch, crowns=((0.8 * top, 0, 0), (0.8 * bottom, 0, 0)),
                    pill=PillReading(score, pill_icon, None, None))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0, rank="pol")
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(32)}
    if ending == "shift":
        screen.vs[31.6] = (0.8, 0.01)
    (_, report, reason), = run(reader, screen, 30.0, 33.0)
    assert reason == ending
    assert report == {"outcome": outcome, "evidence": {
        "crowns": {"top": top, "bottom": bottom}, "deltaSign": None, "deltaIcon": expected_icon}}
    assert not reader.armed and reader.rank == "unknown"


@pytest.mark.parametrize("final,rank", [(False, "pol"), (True, "not_pol"), (True, "unknown")])
def test_crowns_fallback_rejects_unfinished_or_unconfirmed_rank(final, rank) -> None:
    report = decide(samples(*[(0, 1, False, None)] * 16), final=final, pill_seen=False, rank=rank)
    assert report["outcome"] == "unknown"


def test_conflicting_confirmed_signs_cannot_use_crowns_fallback() -> None:
    rows = [(0, 0, True, "+")] * 4 + [(1, 0, True, "-")] * 12
    report = decide(samples(*rows), final=True, pill_seen=True, rank="pol")
    assert report["evidence"]["crowns"] == {"top": 1, "bottom": 0}
    assert report["outcome"] == "unknown"


def test_next_battle_cannot_inherit_previous_rank() -> None:
    reader = ResultReader(templates=object())
    reader.arm(0.0, rank="pol")
    reader.arm(10.0)
    assert reader.rank == "unknown"


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


def test_a_vs_already_above_its_band_is_the_shift(monkeypatch) -> None:
    # A fast shift moves the «vs» out of the home band within one tick.
    screen = Screen(monkeypatch, crowns=((0.8, 0, 0), (0.8, 0, 0)))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 15)}
    screen.shifted[31.5] = (0.8, -0.134)
    (t, report, reason), = run(reader, screen, 30.0, 33.0)
    assert (t, reason) == (31.5, "shift")
    assert report["outcome"] == "draw" and report["evidence"]["crowns"] == {"top": 1, "bottom": 1}


@pytest.mark.parametrize("lost_at", [30.4, 30.9, 31.3])
def test_vs_lost_before_a_seen_shift_never_reports_a_draw(monkeypatch, lost_at) -> None:
    # Review M-8 probe: «vs» from 30.0, then hidden for good; 1:1 on screen.
    screen = Screen(monkeypatch, crowns=((0.8, 0, 0), (0.8, 0, 0)))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(t, 1): (0.85, 0.024) for t in np.arange(30.0, lost_at + 0.01, 0.1)}
    (t, report, reason), = run(reader, screen, 30.0, 33.0)
    assert reason == "vs_lost"
    assert report["outcome"] == "loss"
    assert report["evidence"] == {"crowns": {"top": None, "bottom": None}, "deltaSign": "-", "deltaIcon": "pol"}


@pytest.mark.parametrize("hidden,crowns", [
    ((31.5, 31.6, 31.7, 31.8), {"top": None, "bottom": None}),   # a landing crown hid it: counts not final
    ((31.5,), {"top": 1, "bottom": 1}),                          # one unread tick: still final
])
def test_a_shift_seen_after_a_hidden_vs_keeps_counts_only_after_one_tick(monkeypatch, hidden, crowns) -> None:
    # Review R1-C1 probe: a true 2:1 loss; 1:1 read until the second top crown
    # lands at 1.5 s over the «vs», which reappears already shifted.
    screen = Screen(monkeypatch, crowns=((0.8, 0, 0), (0.8, 0, 0)))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 15)}
    shift_at = round(hidden[-1] + 0.1, 1)
    screen.shifted[shift_at] = (0.8, -0.134)
    (t, report, reason), = run(reader, screen, 30.0, 33.0)
    assert (t, reason) == (shift_at, "shift")
    assert report["evidence"]["crowns"] == crowns
    assert report["outcome"] == ("loss" if crowns["top"] is None else "draw")


def test_a_pol_icon_below_the_seen_score_still_counts_as_a_pill(monkeypatch) -> None:
    # Review R1-C3 probe: the medal is found at 0.52 (>= ICON_T, < ICON_SEEN_T)
    # on alternating reads only; that is a pill, never `absent`.
    screen = Screen(monkeypatch)
    reads = iter([PillReading(0.52, "medal", "-", 0.25), PillReading(0.30, None, None, None)] * 20)
    monkeypatch.setattr(rr, "read_pill", lambda frame, rect, vs, t: next(reads))
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 16)}
    screen.vs[31.6] = (0.8, 0.01)
    (_, report, reason), = run(reader, screen, 30.0, 33.0)
    assert reason == "shift"
    assert report["evidence"]["deltaIcon"] == "unreadable" and report["outcome"] == "unknown"


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


def test_frame_pause_ends_the_burst_on_the_reads_before_it(monkeypatch) -> None:
    screen = Screen(monkeypatch)
    reader = ResultReader(templates=object())
    reader.arm(0.0, delay=0)
    screen.vs = {round(30 + t / 10, 1): (0.85, 0.024) for t in range(0, 60)}
    assert run(reader, screen, 30.0, 30.5) == []
    (t, report, reason), = run(reader, screen, 34.0, 34.0)             # minimised for 3.5 s
    assert reason == "gap" and reader.diagnostics["elapsedS"] == 0.5
    # Read 0.5 s only: final crown counts are never confirmed by the pause.
    assert report["evidence"]["crowns"] == {"top": None, "bottom": None}
    assert report["outcome"] == "loss" and not reader.armed


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
