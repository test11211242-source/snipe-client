"""Bounded live auto setup; the same frame-driven engine is used by offline replay."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import threading
import time
from typing import Any, Callable

import cv2

from geometry.acceptance import accept
from geometry.game_rect import RectResult, detect, pixel_rect
from geometry.vs_finder import HISTORY_FRAMES, MATCH_T, VSConfirmer, normalize_game, search
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import layout_rejection, regions

DEADLINE_MS = 60_000
TARGET_FPS = 10
GEOMETRY_FRAMES = 8
GEOMETRY_INTERVAL = 0.3
PROGRESS_INTERVAL = 0.5
PREVIEW_INTERVAL = 1.0
ICONIC_POLL_INTERVAL = 0.25
ICONIC_LOSS_SECONDS = 1.0
PREVIEW_MAX_SIDE = 640
PREVIEW_JPEG_QUALITY = 70
MAX_PNG_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True)
class AnalysisOutcome:
    result: dict[str, Any]
    frame: Any = None


class AutoSetupEngine:
    """Process unique frames at caller timestamps, never synthesize geometry evidence."""

    def __init__(self, started_at: float) -> None:
        self.started_at = started_at
        self.phase = "locating_game"
        self.frames_analyzed = 0
        self.game = RectResult(None, 0, "too_small")
        self.outcome: AnalysisOutcome | None = None
        self._geometry = deque(maxlen=GEOMETRY_FRAMES)
        self._history = deque(maxlen=HISTORY_FRAMES)
        self._confirmer = VSConfirmer()
        self._last_geometry = -float("inf")
        self._shape = None
        self._onset = None
        self._previous = None
        self._candidate = None
        self._pending = None

    def progress(self, now: float) -> dict[str, Any]:
        return {"phase": self.phase, "elapsedMs": min(DEADLINE_MS, max(0, round((now - self.started_at) * 1000))),
                "game": {"rect": pixel_rect(self.game.rect), "aspect": self.game.aspect}
                if self.game.rect is not None and self.game.reason == "ok" else None,
                "framesAnalyzed": self.frames_analyzed}

    def fail(self, code: str) -> AnalysisOutcome:
        if self.outcome is not None:
            return self.outcome
        result: dict[str, Any] = {"ok": False, "code": code}
        frame = None
        if self._candidate is not None:
            frame, game, badge = self._candidate
            result.update(frameWidth=int(frame.shape[1]), frameHeight=int(frame.shape[0]),
                          game={"rect": pixel_rect(game.rect), "aspect": game.aspect, "chrome": game.chrome},
                          badge=badge.to_dict(), regions={key: zone.to_dict() for key, zone in regions(badge, game.aspect).items()})
        self.outcome = AnalysisOutcome(result, frame)
        return self.outcome

    def deadline(self) -> AnalysisOutcome:
        code = ("AUTO_ASPECT_UNSUPPORTED" if self.game.reason == "aspect_out_of_range" else
                "AUTO_GAME_NOT_FOUND" if self.game.rect is None or len(self._geometry) < GEOMETRY_FRAMES else
                "AUTO_VS_TIMEOUT")
        return self.fail(code)

    def process(self, frame: Any, now: float) -> AnalysisOutcome | None:
        if self.outcome is not None:
            return self.outcome
        if now - self.started_at >= DEADLINE_MS / 1000:
            return self.deadline()
        self.frames_analyzed += 1
        if self._shape != frame.shape:
            self._shape = frame.shape
            self._geometry.clear()
            self._history.clear()
            self._confirmer = VSConfirmer()
            self._onset = self._previous = self._pending = None
            self._last_geometry = -float("inf")
        if now - self._last_geometry >= GEOMETRY_INTERVAL - 1e-9:
            self._geometry.append(frame)
            self.game = detect(list(self._geometry))
            self._last_geometry = now
        game = self.game
        if game.rect is None or game.reason != "ok":
            self.phase = "locating_game"
            self._history.clear()
            self._confirmer = VSConfirmer()
            self._pending = self._onset = self._previous = None
            return None
        normalized = normalize_game(frame, game.rect)
        self._history.append((now, normalized))
        if self._pending is not None:
            trigger, confirmation, confirmed_game, badge, onset, confirm = self._pending
            before = [trigger.score(previous, (0, 0, previous.shape[1], previous.shape[0]))
                      for timestamp, previous in self._history if timestamp <= onset - 1.0 + 1e-9]
            checked = accept(confirmed_game, geometry_frames=GEOMETRY_FRAMES, confirmed=True, badge=badge,
                             trigger=trigger, before_scores=before,
                             vs_scores=[trigger.score(confirmation, confirmed_game.rect), trigger.score(frame, game.rect)])
            if not checked.ok:
                return self.fail("AUTO_" + checked.code)
            result = {"ok": True, "frameWidth": int(confirmation.shape[1]), "frameHeight": int(confirmation.shape[0]),
                      "game": {"rect": pixel_rect(confirmed_game.rect), "aspect": confirmed_game.aspect, "chrome": confirmed_game.chrome},
                      "badge": badge.to_dict(), "regions": {key: zone.to_dict() for key, zone in regions(badge, confirmed_game.aspect).items()},
                      "trigger": trigger.to_dict(), "confidence": checked.confidence,
                      "selfCheck": {"minVs": checked.self_check.min_vs, "maxBefore": checked.self_check.max_before,
                                    "frames": checked.self_check.frames},
                      "timings": {"onsetMs": round((onset - self.started_at) * 1000), "confirmMs": round((confirm - self.started_at) * 1000)}}
            self.outcome = AnalysisOutcome(result, confirmation)
            return self.outcome
        self.phase = "waiting_vs" if len(self._geometry) >= GEOMETRY_FRAMES else "locating_game"
        candidate = search(frame, game.rect, game=normalized)
        if candidate is None or candidate.score < MATCH_T:
            self._onset = None
            self._previous = None
        else:
            if self._previous is not None and not (abs(candidate.cx - self._previous.cx) <= .02
                    and abs(candidate.cy - self._previous.cy) <= .012 and abs(candidate.k - self._previous.k) <= .011):
                self._onset = None
            if self._onset is None:
                self._onset = now
            self._previous = candidate
            self._candidate = (frame, game, candidate.badge)
        before_games = (previous for timestamp, previous in self._history
                        if self._onset is not None and timestamp < self._onset)
        confirmed = self._confirmer.update(frame, game.rect, candidate, game=normalized, before_games=before_games)
        if confirmed and candidate is not None and len(self._geometry) >= GEOMETRY_FRAMES:
            self.phase = "verifying"
            self._candidate = (frame, game, candidate.badge)
            rejection = layout_rejection(candidate.badge, game.aspect)
            if rejection:
                return self.fail("AUTO_" + rejection)
            try:
                trigger = OrientationTrigger.build(frame, game.rect, candidate.badge)
            except ValueError:
                return self.fail("AUTO_TRIGGER_WEAK")
            self._pending = (trigger, frame, game, candidate.badge, self._onset, now)
        return None


def encode_png(frame: Any) -> bytes:
    encoded, png = cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not encoded or not 0 < png.nbytes <= MAX_PNG_BYTES:
        raise ValueError("Capture PNG is invalid or too large")
    return png.tobytes()


def encode_preview(frame: Any) -> tuple[dict[str, Any], bytes]:
    height, width = frame.shape[:2]
    scale = min(1.0, PREVIEW_MAX_SIDE / max(width, height))
    if scale < 1:
        frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
    encoded, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, PREVIEW_JPEG_QUALITY])
    if not encoded:
        raise ValueError("Preview JPEG encoding failed")
    height, width = frame.shape[:2]
    binary = jpeg.tobytes()
    return {"width": int(width), "height": int(height), "mimeType": "image/jpeg", "byteLength": len(binary)}, binary


class LiveAnalysis:
    """One cancellable worker over a latest-frame store; capture never blocks on analysis."""

    def __init__(self, store: Any, emit: Callable, *, clock: Callable[[], float] = time.monotonic,
                 is_iconic: Callable[[], bool] | None = None) -> None:
        self.store, self.emit, self.clock = store, emit, clock
        self.is_iconic = is_iconic
        self.cancelled = threading.Event()
        self.finishing = threading.Event()
        self.engine = AutoSetupEngine(clock())
        self.thread = threading.Thread(target=self._run, name="auto-setup", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def cancel(self) -> None:
        self.cancelled.set()
        self.thread.join()

    def _send(self, event: str, payload: dict[str, Any], binary: bytes = b"") -> None:
        if not self.cancelled.is_set():
            self.emit(event, payload, binary)

    def _run(self) -> None:
        last_sequence = 0
        last_frame = last_progress = last_preview = -float("inf")
        last_iconic_poll = -float("inf")
        iconic_since = None
        try:
            while not self.cancelled.is_set():
                now = self.clock()
                frame, sequence, closed = self.store.snapshot()
                iconic_lost = False
                if self.is_iconic is not None and now - last_iconic_poll >= ICONIC_POLL_INTERVAL:
                    last_iconic_poll = now
                    if self.is_iconic():
                        if iconic_since is None:
                            iconic_since = now
                        iconic_lost = now - iconic_since >= ICONIC_LOSS_SECONDS
                    else:
                        iconic_since = None
                if closed or iconic_lost:
                    outcome = self.engine.fail("AUTO_SOURCE_LOST")
                elif now - self.engine.started_at >= DEADLINE_MS / 1000:
                    outcome = self.engine.deadline()
                else:
                    outcome = None
                    if frame is not None and sequence != last_sequence and now - last_frame >= 1 / TARGET_FPS - 1e-9:
                        last_sequence, last_frame = sequence, now
                        outcome = self.engine.process(frame, now)
                        # Wall clock, not frame timestamps or nominal ticks, owns the deadline.
                        if self.clock() - self.engine.started_at >= DEADLINE_MS / 1000:
                            self.engine.outcome = None
                            outcome = self.engine.deadline()
                    if now - last_progress >= PROGRESS_INTERVAL:
                        self._send("analysis_progress", self.engine.progress(now))
                        last_progress = now
                    if frame is not None and now - last_preview >= PREVIEW_INTERVAL:
                        payload, binary = encode_preview(frame)
                        self._send("analysis_preview", payload, binary)
                        last_preview = now
                if outcome is not None:
                    if not closed and self.store.snapshot()[2]:
                        self.engine.outcome = None
                        outcome = self.engine.fail("AUTO_SOURCE_LOST")
                    binary = encode_png(outcome.frame) if outcome.frame is not None else b""
                    # The result is ready; a retry may safely join this worker's exit.
                    self.finishing.set()
                    self._send("analysis_result", outcome.result, binary)
                    return
                self.cancelled.wait(0.01)
        except Exception:
            outcome = self.engine.fail("AUTO_INTERNAL_ERROR")
            try:
                binary = encode_png(outcome.frame) if outcome.frame is not None else b""
            except Exception:
                outcome, binary = AnalysisOutcome({"ok": False, "code": "AUTO_INTERNAL_ERROR"}), b""
            self.finishing.set()
            self._send("analysis_result", outcome.result, binary)
