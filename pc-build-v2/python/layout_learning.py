"""Five-Hz VS learning with shared acceptance and bounded history (§3.6)."""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import uuid

from geometry.acceptance import accept
from geometry.game_rect import RectResult, pixel_rect
from geometry.vs_finder import MATCH_T, VSConfirmer, normalize_game, search
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import Badge, layout_rejection, regions

LEARNING_HISTORY = 15


def transfer_zone(zone, source: Badge, target: Badge, old_aspect: float, new_aspect: float):
    """Transfer manually authored coordinates in physical badge-width units."""
    values = {"x": target.cx + (zone["x"] - source.cx) / source.width * target.width,
              "y": target.cy + (zone["y"] - source.cy) / (source.width * old_aspect) * target.width * new_aspect,
              "width": zone["width"] / source.width * target.width,
              "height": zone["height"] / (source.width * old_aspect) * target.width * new_aspect}
    return values


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

    def reset(self):
        self.active = False
        self._history.clear()
        self._confirmer = VSConfirmer(history_frames=LEARNING_HISTORY)
        self._pending = None
        self._latched = False
        self._onset = None
        self._shape = None
        self._last_history_sample = -float("inf")

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

    def process(self, frame, now, geometry):
        if not self.enabled:
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
        if geometry.rect is None or geometry.reason != "ok":
            reason = "LEARN_GAME_NOT_FOUND" if geometry.rect is None else "LEARN_ASPECT_UNSUPPORTED"
            if not self.failed:
                self.failed = True
                self._event("failed", reason)
            self._pending = None
            return None
        if now - self._last_sample < 0.2 - 1e-9:
            return None
        self._last_sample = now
        self.buffer(frame, now, geometry)
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
                    new_regions[name] = transfer_zone(source["regions"][name], Badge(**source["badge"]), candidate.badge,
                                                     source["gameAspect"], geometry.aspect)
                    zone = new_regions[name]
                    if zone["x"] < 0 or zone["y"] < 0 or zone["x"] + zone["width"] > 1 or zone["y"] + zone["height"] > 1:
                        self._reject("LEARN_NICKNAME_ZONE_CLIPPED" if name == "nicknameRegion" else "LEARN_LAYOUT_UNEXPECTED")
                        return None
            if len(self.layouts) >= 4:
                learned = [layout for layout in self.layouts if layout["layoutSource"] == "learned"]
                if not learned:
                    self._reject("LAYOUT_LIMIT")
                    return None
                self.layouts.remove(min(learned, key=lambda layout: datetime.fromisoformat(layout["calibratedAt"].replace("Z", "+00:00"))))
            calibrated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            layout = {"layoutId": str(uuid.uuid4()), "layoutSource": "learned", "calibratedAt": calibrated_at,
                      "gameAspect": confirmation_rect[2] / confirmation_rect[3],
                      "windowChrome": geometry.chrome, "regions": new_regions, "trigger": trigger.to_dict(),
                      "badge": candidate.badge.to_dict(), "zonesOrigin": dict(origins)}
            self.layouts.append(layout)
            wire = {"layoutId": layout["layoutId"], "layoutSource": "learned", "calibratedAt": calibrated_at,
                    "gameAspect": layout["gameAspect"], "referenceFrameSize": {"width": confirmation.shape[1], "height": confirmation.shape[0]},
                    "referenceGameRect": pixel_rect(confirmation_rect), "windowChrome": layout["windowChrome"],
                    "expectedLayout": "cr_battle_vs", "triggerRegion": new_regions["trigger"],
                    "nicknameRegion": new_regions["nicknameRegion"], "topLeftEvidenceRegion": new_regions["topLeftEvidenceRegion"],
                    "trigger": layout["trigger"], "confidence": check.confidence}
            self.rejected_count, self.failed, self._latched = 0, False, True
            return layout, wire, confirmation, confirmation_rect
        candidate = search(frame, geometry.rect)
        if candidate is None or candidate.score < MATCH_T:
            self._latched = False
            self._onset = None
        elif self._onset is None:
            self._onset = now
        confirmed = self._confirmer.update(frame, geometry.rect, candidate)
        if confirmed and not self._latched and candidate is not None:
            rejection = layout_rejection(candidate.badge, geometry.aspect)
            sources = [layout for layout in self.layouts if layout["badge"] is not None and
                       abs(candidate.cy - layout["badge"]["cy"]) <= 0.02]
            if rejection or not sources:
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
