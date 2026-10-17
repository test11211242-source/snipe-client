"""Wire values of the C3 prediction detectors (single source on the client).

They match the server validation exactly: `server/routers/streamer_predictions.py`
(`RankEvidence`, `ResultEvidence`, `BattleResultRequest`) and
`server/services/streamer_predictions/engine.py` (`classify_rank_evidence`,
`classify_battle`). Unreadable values are `None` where the server expects null.
"""
from __future__ import annotations

# One nickname line on the battle-start VS screen.
LINE_MEDAL = "medal"        # Ultimate Champion medal icon
LINE_LEAGUE = "league"      # league 1-6 badge
LINE_TROPHY = "trophy"      # trophy-road cup: contract only, no cup template yet (review M-9), reads `empty`
LINE_EMPTY = "empty"        # no icon under the name
LINE_OTHER = "other"        # contract only: never produced (no clan-badge/laurel templates, review M-9)
LINE_UNKNOWN = "unknown"    # unreadable
RANK_LINES = (LINE_MEDAL, LINE_LEAGUE, LINE_TROPHY, LINE_EMPTY, LINE_OTHER, LINE_UNKNOWN)

RANK_POL = "pol"
RANK_NOT_POL = "not_pol"
RANK_UNKNOWN = "unknown"
RANKS = (RANK_POL, RANK_NOT_POL, RANK_UNKNOWN)

OUTCOME_WIN = "win"
OUTCOME_LOSS = "loss"
OUTCOME_DRAW = "draw"
OUTCOME_UNKNOWN = "unknown"
OUTCOMES = (OUTCOME_WIN, OUTCOME_LOSS, OUTCOME_DRAW, OUTCOME_UNKNOWN)

SIGN_PLUS = "+"
SIGN_MINUS = "-"            # ASCII hyphen-minus, never U+2212
SIGN_UNREADABLE = None
DELTA_SIGNS = (SIGN_PLUS, SIGN_MINUS, SIGN_UNREADABLE)

ICON_POL = "pol"            # medal or league badge in the pill
ICON_TROPHY = "trophy"      # contract only: no trophy-pill template yet (review M-9); reads absent/unreadable
ICON_ABSENT = "absent"      # no PoL icon and nothing pill-like in the pill box (not ranked)
ICON_UNREADABLE = "unreadable"
DELTA_ICONS = (ICON_POL, ICON_TROPHY, ICON_ABSENT, ICON_UNREADABLE)

CROWNS_UNREADABLE = None    # per row: 0..3 or None
MAX_CROWNS = 3


def rank_from_lines(opponent: str, own: str) -> str:
    """Same combination as the server's `classify_rank_evidence`."""
    ranked = {LINE_MEDAL, LINE_LEAGUE}
    not_ranked = {LINE_TROPHY, LINE_EMPTY}
    if opponent in ranked | {LINE_UNKNOWN} and own in ranked | {LINE_UNKNOWN}:
        return RANK_POL if opponent in ranked or own in ranked else RANK_UNKNOWN
    if opponent in not_ranked and own in not_ranked:
        return RANK_NOT_POL
    return RANK_UNKNOWN


def outcome_from_evidence(top: int | None, bottom: int | None, sign: str | None, *,
                          icon: str | None = None, rank: str = RANK_UNKNOWN) -> str:
    """The pill sign decides; final crown counts cross-check it or mark a draw.

    Without a read sign, a ranked (PoL) battle without a trophy icon
    is decided by different final crown counts alone:
    more crowns wins. Non-final (null) or equal counts never yield win/loss.
    Otherwise mirrors the consistency checks of the server's `classify_battle`.
    """
    readable = top is not None and bottom is not None
    if readable and top == bottom:
        return OUTCOME_UNKNOWN if sign == SIGN_PLUS else OUTCOME_DRAW
    if sign is SIGN_UNREADABLE:
        if readable and rank == RANK_POL and icon in (ICON_POL, ICON_ABSENT, ICON_UNREADABLE):
            return OUTCOME_WIN if bottom > top else OUTCOME_LOSS
        return OUTCOME_UNKNOWN
    if readable and ((sign == SIGN_PLUS) != (bottom > top)):
        return OUTCOME_UNKNOWN
    return OUTCOME_WIN if sign == SIGN_PLUS else OUTCOME_LOSS
