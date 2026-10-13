"""Five-Hz VS learning with shared acceptance and bounded history (§3.6)."""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import uuid

from geometry.acceptance import accept
from geometry.aspect import ASPECT_MAX, ASPECT_MIN, aspects_overlap
from geometry.game_rect import RectResult, pixel_rect
from geometry.vs_finder import MATCH_T, VSConfirmer, normalize_game, search
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import UI_ASPECT, Badge, _clip, layout_kind, layout_rejection, regions

LEARNING_HISTORY = 15


def transfer_zone(zone, source: Badge, target: Badge, old_aspect: float, new_aspect: float):
    """Transfer manually authored coordinates in physical badge-width units."""
    values = {"x": target.cx + (zone["x"] - source.cx) / source.width * target.width,
              "y": target.cy + (zone["y"] - source.cy) / (source.width * old_aspect) * target.width * new_aspect,
              "width": zone["width"] / source.width * target.width,
              "height": zone["height"] / (source.width * old_aspect) * target.width * new_aspect}
    return values


def transfer_corner_zone(zone, old_aspect: float, new_aspect: float):
    """The top-left zone hangs from the game corner and scales with the interface."""
    old_unit, new_unit = min(1.0, old_aspect / UI_ASPECT), min(1.0, new_aspect / UI_ASPECT)
    horizontal = old_aspect / old_unit * new_unit / new_aspect
    vertical = new_unit / old_unit
    return {"x": zone["x"] * horizontal, "y": zone["y"] * vertical,
            "width": zone["width"] * horizontal, "height": zone["height"] * vertical}


class LayoutLearning:
    def __init__(self, layouts, enabled):
        self.layouts = layouts
        self.enabled = enabled
        self.events = []
        self.rejected_count = 0
        self.active = False
        self.failed = False
        self._history = deque(maxlen=LEARNING_HISTORY)
        self._confirmer = VSConfirmer(history_frames=LEARNING_HISTORY)
        self._pending = None
        self._latched = False
        self._onset = None
        self._last_sample = -float("inf")
        self._last_history_sample = -float("inf")
        self._shape = None

    def _event(self, status, reason=None):
        self.events.append(("learning", {"status": status, "reason": reason, "rejectedCount": self.rejected_count}))

    def _reject(self, code):
        self.rejected_count += 1
        self._event("rejected", code)
        if self.rejected_count >= 2 and not self.failed:
            self.failed = True
            self._event("failed", code)
        self._latched = True
        self._pending = None

    def clear_evidence(self):
        """Discard frame evidence without clearing the learning failure episode."""
        self._history.clear()
        if self._shape is not None:
            self._confirmer = VSConfirmer(history_frames=LEARNING_HISTORY)
        self._pending = None
        self._onset = None
        self._shape = None
        self._last_sample = -float("inf")
        self._last_history_sample = -float("inf")

    def reset(self):
        self.active = False
        self.rejected_count = 0
        self.failed = False
        self.clear_evidence()
        self._latched = False

    def buffer(self, frame, now, geometry):
        """Collect pre-VS evidence during mismatch, before the expensive finder starts."""
        if not self.enabled or geometry.rect is None or geometry.reason != "ok":
            return
        # Tiny union-rectangle drift must not erase the pre-VS evidence ring.
        if self._shape != frame.shape:
            self._history.clear()
            self._confirmer = VSConfirmer(history_frames=LEARNING_HISTORY)
            self._pending = None
            self._latched = False
            self._onset = None
            self._shape = frame.shape
            self._last_history_sample = -float("inf")
        if now - self._last_history_sample >= 0.2 - 1e-9:
            self._history.append((now, normalize_game(frame, geometry.rect)))
            self._last_history_sample = now
        if abs(now - self._last_history_sample) < 1e-9:
            return self._history[-1][1]
        return None

    def process(self, frame, now, geometry):
        if not self.enabled or geometry.rect is None:
            return None
        if not self.active:
            self.active = True
            if not any(layout["trigger"]["kind"] == "vs_edge_orientation" for layout in self.layouts):
                self.failed = True
                self._event("failed", "LEARN_STRUCTURAL_TRIGGER")
                return None
            self._event("waiting_vs")
        if not any(layout["trigger"]["kind"] == "vs_edge_orientation" for layout in self.layouts):
            return None
        if geometry.reason != "ok":
            if not self.failed:
                self.failed = True
                self._event("failed", "LEARN_ASPECT_UNSUPPORTED")
            self._pending = None
            return None
        if now - self._last_sample < 0.2 - 1e-9:
            return None
        self._last_sample = now
        game = self.buffer(frame, now, geometry)
        if game is None:
            game = normalize_game(frame, geometry.rect)
        if self._pending is not None:
            pending = self._pending
            self._pending = None
            trigger, candidate, confirmation, confirmation_rect, source, onset = pending
            before = [trigger.score(previous, (0, 0, previous.shape[1], previous.shape[0]))
                      for timestamp, previous in self._history if timestamp <= onset - 1.0 + 1e-9]
            check = accept(RectResult(confirmation_rect, confirmation_rect[2] / confirmation_rect[3], "ok"),
                           geometry_frames=geometry.frames, confirmed=True, badge=candidate.badge, trigger=trigger,
                           before_scores=before, vs_scores=[trigger.score(confirmation, confirmation_rect), trigger.score(frame, geometry.rect)])
            if not check.ok:
                self._reject("LEARN_" + check.code)
                return None
            zones = regions(candidate.badge, geometry.aspect)
            new_regions = {"trigger": zones["trigger"].to_dict(), "nicknameRegion": zones["nickname"].to_dict(),
                           "topLeftEvidenceRegion": zones["topLeftEvidence"].to_dict()}
            origins = source["zonesOrigin"]
            for name, origin_name in (("nicknameRegion", "nickname"), ("topLeftEvidenceRegion", "topLeftEvidence")):
                if origins[origin_name] == "manual":
                    if name == "topLeftEvidenceRegion":
                        zone = transfer_corner_zone(source["regions"][name], source["gameAspect"], geometry.aspect)
                    else:
                        zone = transfer_zone(source["regions"][name], Badge(**source["badge"]), candidate.badge,
                                             source["gameAspect"], geometry.aspect)
                    new_regions[name] = zone
                    if name == "topLeftEvidenceRegion":
                        clipped = _clip(zone["x"], zone["y"], zone["x"] + zone["width"], zone["y"] + zone["height"])
                        if clipped.width <= 0 or clipped.height <= 0:
                            self._reject("LEARN_LAYOUT_UNEXPECTED")
                            return None
                        new_regions[name] = clipped.to_dict()
                    elif zone["x"] < 0 or zone["y"] < 0 or zone["x"] + zone["width"] > 1 or zone["y"] + zone["height"] > 1:
                        self._reject("LEARN_NICKNAME_ZONE_CLIPPED")
                        return None
            aspect = confirmation_rect[2] / confirmation_rect[3]
            if not ASPECT_MIN <= aspect <= ASPECT_MAX:
                self._reject("LEARN_ASPECT_UNSUPPORTED")
                return None
            if any(aspects_overlap(layout["gameAspect"], aspect) for layout in self.layouts):
                self._reject("LEARN_LAYOUT_OVERLAP")
                return None
            if len(self.layouts) >= 4:
                learned = [layout for layout in self.layouts if layout["layoutSource"] == "learned"]
                if not learned:
                    self._reject("LAYOUT_LIMIT")
                    return None
                self.layouts.remove(min(learned, key=lambda layout: datetime.fromisoformat(layout["calibratedAt"].replace("Z", "+00:00"))))
            calibrated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            layout = {"layoutId": str(uuid.uuid4()), "layoutSource": "learned", "calibratedAt": calibrated_at,
                      "gameAspect": aspect,
                      "windowChrome": geometry.chrome, "regions": new_regions, "trigger": trigger.to_dict(),
                      "badge": candidate.badge.to_dict(), "zonesOrigin": dict(origins)}
            self.layouts.append(layout)
            wire = {"layoutId": layout["layoutId"], "layoutSource": "learned", "calibratedAt": calibrated_at,
                    "gameAspect": layout["gameAspect"], "referenceFrameSize": {"width": confirmation.shape[1], "height": confirmation.shape[0]},
                    "referenceGameRect": pixel_rect(confirmation_rect), "windowChrome": layout["windowChrome"],
                    "expectedLayout": "cr_battle_vs", "triggerRegion": new_regions["trigger"],
                    "nicknameRegion": new_regions["nicknameRegion"], "topLeftEvidenceRegion": new_regions["topLeftEvidenceRegion"],
                    "trigger": layout["trigger"], "zonesOrigin": dict(origins), "confidence": check.confidence}
            self.rejected_count, self.failed, self._latched = 0, False, True
            return layout, wire, confirmation, confirmation_rect
        candidate = search(frame, geometry.rect, game=game)
        if candidate is None or candidate.score < MATCH_T:
            self._latched = False
            self._onset = None
        elif self._onset is None:
            self._onset = now
        before_games = (previous for timestamp, previous in self._history
                        if self._onset is not None and timestamp < self._onset)
        confirmed = self._confirmer.update(frame, geometry.rect, candidate, game=game, before_games=before_games)
        if confirmed and not self._latched and candidate is not None:
            rejection = layout_rejection(candidate.badge, geometry.aspect)
            kinds = {layout_kind(Badge(**layout["badge"])) for layout in self.layouts if layout["badge"] is not None}
            sources = [layout for layout in self.layouts if layout["badge"] is not None and
                       abs(candidate.cy - layout["badge"]["cy"]) <= 0.02]
            if not rejection and layout_kind(candidate.badge) not in kinds:
                # A profile learns only from its own VS layout: own-battle
                # profiles ignore spectating and vice versa, without failing.
                self._latched = True
            elif rejection or not sources:
                self._reject("LEARN_" + (rejection or "LAYOUT_UNEXPECTED"))
            else:
                source = min(sources, key=lambda layout: abs(geometry.aspect / layout["gameAspect"] - 1))
                trigger = OrientationTrigger.build(frame, geometry.rect, candidate.badge)
                self._pending = (trigger, candidate, frame.copy(), geometry.rect, source, self._onset)
                self._latched = True
        return None

    def take_events(self):
        events, self.events = self.events, []
        return events
