"""Shared feature alignment used by trigger analysis and runtime matching."""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

ORB_FEATURES = 400
ORB_MIN_INLIERS = 6


@dataclass(frozen=True)
class OrbAlignment:
    inliers: int
    score: float

    @property
    def viable(self) -> bool:
        return self.inliers >= ORB_MIN_INLIERS


def create_orb():
    return cv2.ORB_create(nfeatures=ORB_FEATURES)


def create_orb_matcher():
    return cv2.BFMatcher(cv2.NORM_HAMMING)


def score_orb_alignment(
    template_keypoints,
    template_descriptors: np.ndarray | None,
    candidate_structure: np.ndarray,
    *,
    orb=None,
    matcher=None,
) -> OrbAlignment:
    if template_descriptors is None or len(template_keypoints) < ORB_MIN_INLIERS:
        return OrbAlignment(0, 0.0)
    detector = orb if orb is not None else create_orb()
    candidate_keypoints, candidate_descriptors = detector.detectAndCompute(
        candidate_structure, None
    )
    if (
        candidate_descriptors is None
        or len(candidate_keypoints) < ORB_MIN_INLIERS
    ):
        return OrbAlignment(0, 0.0)
    feature_matcher = matcher if matcher is not None else create_orb_matcher()
    pairs = feature_matcher.knnMatch(
        template_descriptors, candidate_descriptors, k=2
    )
    good = [
        pair[0]
        for pair in pairs
        if len(pair) == 2 and pair[0].distance < 0.76 * pair[1].distance
    ]
    if len(good) < ORB_MIN_INLIERS:
        return OrbAlignment(0, 0.0)
    source = np.float32(
        [template_keypoints[match.queryIdx].pt for match in good]
    )
    target = np.float32(
        [candidate_keypoints[match.trainIdx].pt for match in good]
    )
    matrix, inlier_mask = cv2.estimateAffinePartial2D(
        source, target, method=cv2.RANSAC, ransacReprojThreshold=3.0
    )
    if matrix is None or inlier_mask is None:
        return OrbAlignment(0, 0.0)
    inliers = int(inlier_mask.sum())
    inlier_ratio = inliers / len(good)
    scale = float(math.hypot(matrix[0, 0], matrix[0, 1]))
    rotation = abs(math.degrees(math.atan2(matrix[0, 1], matrix[0, 0])))
    translation = float(math.hypot(matrix[0, 2], matrix[1, 2]))
    if not 0.9 <= scale <= 1.1 or rotation > 6.0 or translation > 10.0:
        return OrbAlignment(0, 0.0)
    score = min(1.0, inliers / 12.0) * min(1.0, inlier_ratio / 0.6)
    return OrbAlignment(inliers, score)
