"""Generate the versioned name-free VS crop/mask from external 3.png (§3.2).

HSV is used ONLY by this offline asset authoring tool, as in the reference.
No HSV or colour matching is present in the runtime geometry algorithms.
The source image is never copied to the output directory.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry.game_rect import detect


def generate(source: Path, output: Path) -> None:
    image = cv2.imdecode(np.fromfile(source, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Cannot decode the external source image")
    game = detect([image])
    if game.rect is None or game.reason != "ok":
        raise ValueError("Source image has no supported game rectangle")
    gx, gy, gw, gh = game.rect
    x0, y0 = int(gx + 0.3 * gw), int(gy + 0.33 * gh)
    area = image[y0:int(gy + 0.53 * gh), x0:int(gx + 0.7 * gw)]
    hsv = cv2.cvtColor(area, cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (15, 120, 150), (35, 255, 255))
    blue = cv2.inRange(hsv, (100, 120, 120), (125, 255, 255))
    combined = cv2.morphologyEx(yellow | blue, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(combined)
    if count < 2:
        raise ValueError("Source badge silhouette was not found")
    label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, width, height = (int(v) for v in stats[label, :4])
    if (width, height) != (132, 159):
        raise ValueError("Source does not match the approved 132×159 badge")
    component = (labels == label).astype(np.uint8) * 255
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    silhouette = np.zeros_like(component)
    cv2.drawContours(silhouette, contours, -1, 255, -1)
    margin = round(width * 0.12)
    bx, by = x0 + x, y0 + y
    crop = image[by - margin:by + height + margin, bx - margin:bx + width + margin]
    mask = np.zeros(crop.shape[:2], np.uint8)
    mask[margin:margin + height, margin:margin + width] = silhouette[y:y + height, x:x + width]
    output.mkdir(parents=True, exist_ok=True)
    for name, value in (("vs_badge_v1.png", crop), ("vs_badge_v1_mask.png", mask)):
        ok, encoded = cv2.imencode(".png", value)
        if not ok:
            raise ValueError("Asset encoding failed")
        (output / name).write_bytes(encoded.tobytes())
    print("Generated approved VS badge and silhouette mask (132×159, margin 16)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    args = parser.parse_args()
    generate(args.source, args.out)
