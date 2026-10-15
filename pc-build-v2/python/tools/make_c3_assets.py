"""Generate the C3 shape-only templates (one-time offline authoring).

    make_c3_assets.py --clip <external end-of-battle .mp4> --vs-frame 700 --crown-frame 745
                      --leagues <dir with league-1..7.webp> --medal <medal.png>

The clip frames are read in memory only; the output stores quantised edge
orientation fields of a name-free «vs» glyph and one cushion crown (no
pixels, no colour, no player names) plus SHA-256 identities of every source.
League/medal templates come from the art files the plan names
(`server/admin-app/src/assets/leagues`, `server/public-reports/medal.png`).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry.game_rect import detect
from geometry.rank_line import RANK_PX, RANK_TEMPLATE_HEIGHTS
from geometry.result_screen import CROWN_PX, PILL_ICON_UNITS, PILL_PX, VS_PX
from geometry.shape_match import ShapeTemplate, crop_units, game_center

ASSETS = Path(__file__).resolve().parents[1] / "assets"
# Boxes around the game centre, units; cut from the owner's clip «2» (1548×2160).
VS_GLYPH = (-0.028, 0.026, 0.004, 0.043)
CROWN = (-0.207, -0.077, -0.22, -0.097)
PILL_MEDAL_HEIGHT = round(PILL_ICON_UNITS["medal"] * PILL_PX)
PILL_LEAGUE_HEIGHT = round(PILL_ICON_UNITS["league"] * PILL_PX)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _frames(path: Path, wanted: set[int]) -> dict[int, np.ndarray]:
    capture = cv2.VideoCapture(str(path))
    frames, index, samples = {}, 0, []
    try:
        while len(frames) < len(wanted) or len(samples) < 8:
            ok, frame = capture.read()
            if not ok:
                break
            if index in wanted:
                frames[index] = frame
            if index % 60 == 0 and len(samples) < 8:
                samples.append(frame)
            index += 1
    finally:
        capture.release()
    if set(frames) != wanted:
        raise ValueError("Clip is shorter than the requested frames")
    frames[-1] = samples  # type: ignore[assignment]
    return frames


def art_template(path: Path, height: int, name: str) -> ShapeTemplate:
    image = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise ValueError(f"{path.name}: RGBA art required")
    scale = height / image.shape[0]
    image = cv2.resize(image, (round(image.shape[1] * scale), height), interpolation=cv2.INTER_AREA)
    image = cv2.copyMakeBorder(image, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=(128, 128, 128, 0))
    alpha = image[:, :, 3:4].astype(np.float32) / 255
    # Neutral grey behind the art: the outline edge exists against any background.
    bgr = (image[:, :, :3] * alpha + 128 * (1 - alpha)).astype(np.uint8)
    weight = cv2.dilate((image[:, :, 3] > 20).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32)
    return ShapeTemplate.build(bgr, name, weight=weight,
                               source={"file": path.name, "sha256": _sha(path), "height": height})


def generate(clip: Path, vs_frame: int, crown_frame: int, leagues: Path, medal: Path, output: Path) -> None:
    frames = _frames(clip, {vs_frame, crown_frame})
    game = detect(frames[-1])
    if game.rect is None or game.reason != "ok":
        raise ValueError("Clip has no supported game rectangle")
    rect, centre = game.rect, game_center(game.rect)
    clip_source = {"sha256": _sha(clip), "gameAspect": round(game.aspect, 4)}

    def cut(index: int, box, px: int, name: str) -> ShapeTemplate:
        crop = crop_units(frames[index], rect, centre, box, px)
        if crop is None:
            raise ValueError(f"{name}: crop outside the game")
        return ShapeTemplate.build(crop.image, name, source={**clip_source, "frame": index, "box": list(box)})

    result = [cut(vs_frame, VS_GLYPH, VS_PX, "result-vs"), cut(crown_frame, CROWN, CROWN_PX, "crown"),
              art_template(medal, PILL_MEDAL_HEIGHT, "pill-medal")]
    result += [art_template(leagues / f"league-{n}.webp", PILL_LEAGUE_HEIGHT, f"pill-league-{n}") for n in range(1, 7)]
    rank = [art_template(medal, RANK_TEMPLATE_HEIGHTS["medal"], "rank-medal")]
    rank += [art_template(leagues / f"league-{n}.webp", RANK_TEMPLATE_HEIGHTS["league"], f"rank-league-{n}")
             for n in range(1, 8)]
    output.mkdir(parents=True, exist_ok=True)
    for name, templates, px in (("result_screen_v1.json", result, {"vs": VS_PX, "crown": CROWN_PX, "pill": PILL_PX}),
                                ("pol_rank_v1.json", rank, {"rank": RANK_PX})):
        document = {"version": 1, "pxPerUnit": px, "templates": [template.to_dict() for template in templates]}
        (output / name).write_text(json.dumps(document, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print("Generated", ", ".join(t.name for t in result + rank))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clip", type=Path, required=True)
    parser.add_argument("--vs-frame", type=int, default=700)
    parser.add_argument("--crown-frame", type=int, default=745)
    parser.add_argument("--leagues", type=Path, required=True)
    parser.add_argument("--medal", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ASSETS)
    args = parser.parse_args()
    generate(args.clip, args.vs_frame, args.crown_frame, args.leagues, args.medal, args.out)
