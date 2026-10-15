"""End-of-battle result reading for predictions (C3.b), on the normal tick.

Integration is one object per monitor session:

    reader = ResultReader()                     # loads the bundled templates
    reader.arm(now)                             # on every own-battle VS (kind == "battle")
    report = reader.process(frame, game_rect, now)   # every tick while armed
    if report is not None: emit prediction_result {battleId, gap, **report}

`process` returns `{"outcome", "evidence": {"crowns", "deltaSign", "deltaIcon"}}`
once per armed battle, with values from `prediction_values`; `diagnostics`
holds the codes and timings of the last burst (never sent to users).

While armed and idle only the small result-«vs» band is checked. The first
match starts the burst: for at most `BURST_CAP_S`, each tick also reads the
pill and the six crown slots, and the burst ends as soon as the «vs» moves up
(the screen starts shifting, after which the player may skip) or is missing
for `MISSING_S`. Ticks without the «vs» at its place are never read.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from geometry.result_screen import (ICON_SEEN_T, VS_FIRE_T, VS_KEEP_T, ResultTemplates, count_crowns, crown_scores,
                                    find_vs, read_pill)
from prediction_values import (CROWNS_UNREADABLE, ICON_ABSENT, ICON_POL, ICON_UNREADABLE, SIGN_UNREADABLE,
                               outcome_from_evidence)

ARM_DELAY_S = 20.0          # no battle ends sooner than 20 s after its VS
ARM_WINDOW_S = 7 * 60.0     # nor later than 7 min
BURST_CAP_S = 3.0           # measured shift start <= 2.35 s
# Crowns dropping onto the «vs» hide it for up to ~0.4 s (owner clip 8).
MISSING_S = 0.6
# The «vs» moved up by more than this (units) = the shift has started.
SHIFT_UNITS = 0.006
# Wobble/jitter tolerance of the settled «vs» position.
HOME_UNITS = 0.006
# No pill by then means no pill (measured pill readable <= 0.55 s).
PILL_ABSENT_S = 0.7
# Crown counts settle >= 1.13 s, the shift starts >= 1.40 s after the «vs»;
# a burst ending sooner never confirms final counts (no 0:0 «draw» from a skip).
CROWNS_FINAL_S = 1.0
CONFIRM = 2


@dataclass
class _Sample:
    t: float
    top: int
    bottom: int
    icon: bool
    sign: str | None


@dataclass
class _Burst:
    start: float
    home: tuple[float, float]
    home_units: float
    samples: list[_Sample] = field(default_factory=list)
    missing_since: float | None = None
    pill_seen: bool = False
    ticks: int = 0


def decide(samples: list[_Sample], *, elapsed: float, pill_seen: bool) -> dict[str, Any]:
    """Pure decision over the burst samples (in tick order)."""
    confirmed: set[str] = set()
    icon = False
    for previous, current in zip(samples, samples[1:]):
        if previous.icon and current.icon:
            icon = True
            if current.sign is not None and current.sign == previous.sign:
                confirmed.add(current.sign)
    sign = next(iter(confirmed)) if len(confirmed) == 1 else SIGN_UNREADABLE
    if icon:
        delta_icon = ICON_POL
    elif pill_seen or elapsed < PILL_ABSENT_S:
        delta_icon = ICON_UNREADABLE
    else:
        delta_icon = ICON_ABSENT
    top = bottom = CROWNS_UNREADABLE
    counts = [(sample.top, sample.bottom) for sample in samples]
    # A count holds when two consecutive samples agree; a landing crown may
    # flicker for one sample. Held counts only grow.
    held = [b for a, b in zip(counts, counts[1:]) if a == b]
    growing = all(b[0] >= a[0] and b[1] >= a[1] for a, b in zip(held, held[1:]))
    if elapsed >= CROWNS_FINAL_S and len(counts) >= CONFIRM and growing and counts[-1] == counts[-2]:
        top, bottom = counts[-1]
    return {"outcome": outcome_from_evidence(top, bottom, sign),
            "evidence": {"crowns": {"top": top, "bottom": bottom}, "deltaSign": sign, "deltaIcon": delta_icon}}


class ResultReader:
    def __init__(self, templates: ResultTemplates | None = None):
        self.templates = templates or ResultTemplates.load()
        self.armed_from: float | None = None
        self.armed_until: float | None = None
        self.burst: _Burst | None = None
        self.diagnostics: dict[str, Any] | None = None

    @property
    def armed(self) -> bool:
        return self.armed_until is not None

    def arm(self, now: float, *, delay: float = ARM_DELAY_S) -> None:
        """Own-battle VS seen: watch for its result screen. Re-arming at the
        next VS drops an unreported battle (the server marks it missed)."""
        self.armed_from, self.armed_until = now + delay, now + ARM_WINDOW_S
        self.burst = None

    def disarm(self) -> None:
        self.armed_from = self.armed_until = None
        self.burst = None

    def finish(self, now: float) -> dict[str, Any] | None:
        """Capture stopped mid-burst: report what was read so far."""
        return self._finish(now, "capture_end") if self.burst is not None else None

    def process(self, frame: np.ndarray, rect, now: float) -> dict[str, Any] | None:
        if self.armed_until is None:
            return None
        if self.burst is None:
            if now > self.armed_until:
                self.disarm()
                return None
            if now < self.armed_from or rect is None:
                return None
            hit = find_vs(frame, rect, self.templates)
            if hit is None or hit.score < VS_FIRE_T:
                return None
            self.burst = _Burst(now, (hit.x, hit.y), hit.uy)
        return self._burst_tick(frame, rect, now)

    def _burst_tick(self, frame: np.ndarray, rect, now: float) -> dict[str, Any] | None:
        burst = self.burst
        burst.ticks += 1
        if rect is None:
            return self._finish(now, "no_game")
        # The first tick reuses the trigger hit.
        hit = find_vs(frame, rect, self.templates) if burst.ticks > 1 else None
        if burst.ticks > 1:
            if hit is not None and hit.score >= VS_KEEP_T and hit.uy < burst.home_units - SHIFT_UNITS:
                return self._finish(now, "shift")
            if hit is None or hit.score < VS_KEEP_T or abs(hit.uy - burst.home_units) > HOME_UNITS:
                # Hidden (a crown over it), gone (skipped) or misplaced: never read.
                burst.missing_since = now if burst.missing_since is None else burst.missing_since
                if now - burst.missing_since >= MISSING_S:
                    return self._finish(now, "vs_lost")
                return self._finish(now, "cap") if now - burst.start >= BURST_CAP_S else None
            burst.missing_since = None
            burst.home = (hit.x, hit.y)
        crowns = count_crowns(crown_scores(frame, rect, burst.home, self.templates))
        pill = read_pill(frame, rect, burst.home, self.templates)
        burst.pill_seen |= pill.icon_score >= ICON_SEEN_T
        burst.samples.append(_Sample(round(now - burst.start, 3), crowns["top"], crowns["bottom"],
                                     pill.icon is not None, pill.sign))
        if now - burst.start >= BURST_CAP_S:
            return self._finish(now, "cap")
        return None

    def _finish(self, now: float, reason: str) -> dict[str, Any]:
        burst = self.burst
        elapsed = now - burst.start
        report = decide(burst.samples, elapsed=elapsed, pill_seen=burst.pill_seen)
        self.diagnostics = {"endReason": reason, "elapsedS": round(elapsed, 3), "ticks": burst.ticks,
                            "trace": [[s.t, s.top, s.bottom, int(s.icon), s.sign] for s in burst.samples]}
        self.disarm()
        return report
