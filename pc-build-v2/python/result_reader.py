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
(the screen starts shifting, after which the player may skip; a «vs» already
above its band counts too) or is missing for `MISSING_S`. Ticks without the
«vs» at its place are never read. A pause in the frames longer than
`MISSING_S` (minimised source, stalled capture) ends the burst on what was read
before it (`endReason == "gap"`). Crown counts are reported only after a seen
shift or the cap; the pill sign decides. Without a read sign, a battle armed
with a PoL VS rank and no trophy icon is decided by different final crowns.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from geometry.result_screen import (ICON_SEEN_T, VS_FIRE_T, VS_KEEP_T, VS_SHIFTED_BAND, ResultTemplates, count_crowns,
                                    crown_scores, find_vs, read_pill)
from prediction_values import (CROWNS_UNREADABLE, ICON_ABSENT, ICON_POL, ICON_UNREADABLE, RANK_UNKNOWN,
                               SIGN_UNREADABLE, outcome_from_evidence)

ARM_DELAY_S = 20.0          # no battle ends sooner than 20 s after its VS
ARM_WINDOW_S = 7 * 60.0     # nor later than 7 min
BURST_CAP_S = 3.0           # measured shift start <= 2.35 s
# Crowns dropping onto the «vs» hide it for up to ~0.4 s (owner clip 8).
MISSING_S = 0.6
# The «vs» moved up by more than this (units) = the shift has started.
SHIFT_UNITS = 0.006
# Wobble/jitter tolerance of the settled «vs» position.
HOME_UNITS = 0.006
# No pill by the last read means no pill (measured pill readable <= 0.55 s).
PILL_ABSENT_S = 0.7
# Crown counts settle 0.95-2.13 s after the «vs» (one crown after another);
# the shift starts only after the last one. Counts are final only when the
# burst saw the shift (or ran to the cap) and the last read is this late; any
# other end (a hidden/skipped «vs», a pause, a lost game, capture stop) may
# cut the counts short, so they stay null and never make a «draw».
CROWNS_FINAL_S = 1.0
FINAL_REASONS = ("shift", "cap")
# A shift seen right after the «vs» went unread for longer than one tick
# (0.1 s at 10 FPS) is not final: a crown landing over it hides it for
# 0.2-0.4 s, and its counts were read before that crown (review R1-C1).
FINAL_GAP_S = 0.15
CONFIRM = 2
END_REASONS = ("shift", "vs_lost", "cap", "no_game", "gap", "capture_end")


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
    last: float = 0.0


def decide(samples: list[_Sample], *, final: bool, pill_seen: bool, rank: str = RANK_UNKNOWN) -> dict[str, Any]:
    """Pure decision over the burst samples (in tick order); `final` = the
    burst ended where the crowns have all landed (shift seen, or the cap)."""
    last_read = samples[-1].t if samples else 0.0
    confirmed: set[str] = set()
    icon = False
    for previous, current in zip(samples, samples[1:]):
        if previous.icon and current.icon:
            icon = True
            if current.sign is not None and current.sign == previous.sign:
                confirmed.add(current.sign)
    sign = next(iter(confirmed)) if len(confirmed) == 1 else SIGN_UNREADABLE
    # No trophy-pill template yet (review M-9): a trophy-road pill reads
    # `absent` (nothing PoL-like) or `unreadable`; `pol` needs the PoL icon on
    # two consecutive reads. Its VS reads `not_pol` (a cup scores as an empty
    # line), and the server counts a `not_pol` battle as not ranked with
    # `absent`, as `unknown` with anything else; never as a win or loss.
    if icon:
        delta_icon = ICON_POL
    elif pill_seen or last_read < PILL_ABSENT_S:
        delta_icon = ICON_UNREADABLE
    else:
        delta_icon = ICON_ABSENT
    top = bottom = CROWNS_UNREADABLE
    counts = [(sample.top, sample.bottom) for sample in samples]
    # A count holds when two consecutive samples agree; a landing crown may
    # flicker for one sample. Held counts only grow.
    held = [b for a, b in zip(counts, counts[1:]) if a == b]
    growing = all(b[0] >= a[0] and b[1] >= a[1] for a, b in zip(held, held[1:]))
    if (final and last_read >= CROWNS_FINAL_S and len(counts) >= CONFIRM and growing
            and counts[-1] == counts[-2]):
        top, bottom = counts[-1]
    # Conflicting confirmed signs are contradictory evidence, not a missing sign.
    outcome = ("unknown" if len(confirmed) > 1 else
               outcome_from_evidence(top, bottom, sign, icon=delta_icon, rank=rank))
    return {"outcome": outcome,
            "evidence": {"crowns": {"top": top, "bottom": bottom}, "deltaSign": sign, "deltaIcon": delta_icon}}


class ResultReader:
    def __init__(self, templates: ResultTemplates | None = None):
        self.templates = templates or ResultTemplates.load()
        self.armed_from: float | None = None
        self.armed_until: float | None = None
        self.burst: _Burst | None = None
        self.rank = RANK_UNKNOWN   # VS rank of the armed battle (`rank_from_lines`)
        self.diagnostics: dict[str, Any] | None = None

    @property
    def armed(self) -> bool:
        return self.armed_until is not None

    def arm(self, now: float, *, delay: float = ARM_DELAY_S, rank: str = RANK_UNKNOWN) -> None:
        """Own-battle VS seen: watch for its result screen. Re-arming at the
        next VS drops an unreported battle (the server marks it missed)."""
        self.armed_from, self.armed_until = now + delay, now + ARM_WINDOW_S
        self.burst = None
        self.rank = rank

    def disarm(self) -> None:
        self.armed_from = self.armed_until = None
        self.burst = None
        self.rank = RANK_UNKNOWN

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
        if burst.ticks and now - burst.last > MISSING_S:
            # The frames paused: nothing after the pause belongs to this read.
            return self._finish(burst.last, "gap")
        burst.ticks += 1
        burst.last = now
        if rect is None:
            return self._finish(now, "no_game")
        # The first tick reuses the trigger hit.
        hit = find_vs(frame, rect, self.templates) if burst.ticks > 1 else None
        if burst.ticks > 1:
            if hit is not None and hit.score >= VS_KEEP_T and hit.uy < burst.home_units - SHIFT_UNITS:
                return self._finish(now, "shift")
            if hit is None or hit.score < VS_KEEP_T or abs(hit.uy - burst.home_units) > HOME_UNITS:
                # Gone from home: shifted up past the band (a fast shift), hidden
                # (a crown over it), skipped or misplaced. Only the first is final.
                shifted = find_vs(frame, rect, self.templates, VS_SHIFTED_BAND)
                if (shifted is not None and shifted.score >= VS_FIRE_T
                        and shifted.uy < burst.home_units - SHIFT_UNITS):
                    return self._finish(now, "shift")
                burst.missing_since = now if burst.missing_since is None else burst.missing_since
                if now - burst.missing_since >= MISSING_S:
                    return self._finish(now, "vs_lost")
                return self._finish(now, "cap") if now - burst.start >= BURST_CAP_S else None
            burst.missing_since = None
            burst.home = (hit.x, hit.y)
        crowns = count_crowns(crown_scores(frame, rect, burst.home, self.templates))
        pill = read_pill(frame, rect, burst.home, self.templates)
        # A detected PoL icon is a pill, even below the «pill seen» score (review R1-C3).
        burst.pill_seen |= pill.icon is not None or pill.icon_score >= ICON_SEEN_T
        burst.samples.append(_Sample(round(now - burst.start, 3), crowns["top"], crowns["bottom"],
                                     pill.icon is not None, pill.sign))
        if now - burst.start >= BURST_CAP_S:
            return self._finish(now, "cap")
        return None

    def _finish(self, now: float, reason: str) -> dict[str, Any]:
        burst = self.burst
        elapsed = now - burst.start
        final = reason in FINAL_REASONS and (
            burst.missing_since is None or now - burst.missing_since <= FINAL_GAP_S)
        report = decide(burst.samples, final=final, pill_seen=burst.pill_seen, rank=self.rank)
        self.diagnostics = {"endReason": reason, "startS": round(burst.start, 3), "elapsedS": round(elapsed, 3),
                            "ticks": burst.ticks,
                            "trace": [[s.t, s.top, s.bottom, int(s.icon), s.sign] for s in burst.samples]}
        self.disarm()
        return report
