"""Subprocess fixtures for TS strict parsing; production main functions emit CRT2."""
from __future__ import annotations

import os
from pathlib import Path
import sys
from typing import Any

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from synthetic_frames import arena, framed
import prepared_capture


def emit_fixture(mode: str) -> None:
    if mode == "fixture-vs":
        image, _ = arena()
    else:
        image = np.full((240, 320, 3), (24, 38, 62), dtype=np.uint8)
        cv2.rectangle(image, (122, 78), (202, 162), (235, 235, 235), 3)
        cv2.line(image, (132, 92), (192, 148), (235, 235, 235), 5)
        cv2.circle(image, (176, 112), 13, (20, 20, 20), 3)
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("Synthetic fixture PNG encoding failed")
    sys.stdout.buffer.write(encoded.tobytes())


def run_prepared(mode: str) -> None:
    # Replace only capture IO and the sampling clock. History, detection, PNG
    # encoding, command validation and CRT2 event production stay genuine.
    original_publish = prepared_capture.LatestFrameStore.publish
    sample_index = 0

    def sampled_publish(store: Any, frame: Any, **_kwargs: Any) -> tuple[bool, int, int, int]:
        nonlocal sample_index
        timestamp = sample_index * 0.31
        sample_index += 1
        return original_publish(store, frame, timestamp=timestamp)

    class SyntheticBackend:
        def __init__(self, _selector: dict[str, Any]) -> None:
            pass

        def start(self, on_frame: Any, _on_closed: Any) -> None:
            external_path = os.environ.get("SNIPE_SETUP_CONTRACT_FRAME")
            external = None
            if external_path:
                external = cv2.imread(external_path, cv2.IMREAD_COLOR)
                if external is None:
                    raise RuntimeError("External setup contract frame cannot be decoded")
            samples = 1 if mode == "prepared-insufficient" else 9
            for index in range(samples):
                if external is not None:
                    frame = external
                else:
                    image, _ = arena(seed=index, badge=False)
                    image = np.clip(image.astype(np.int16) + (index % 2) * 80, 0, 255).astype(np.uint8)
                    frame, _ = framed(image, toolbar=24)
                on_frame(frame)

        def stop(self) -> None:
            pass

    prepared_capture.LatestFrameStore.publish = sampled_publish
    prepared_capture.WindowsMonitorBackend = SyntheticBackend
    prepared_capture.main()


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode in ("fixture-vs", "fixture-non-vs"):
        emit_fixture(mode)
    elif mode in ("prepared", "prepared-insufficient"):
        run_prepared(mode)
    else:
        raise ValueError("Unknown setup contract harness mode")
