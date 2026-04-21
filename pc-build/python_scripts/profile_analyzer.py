#!/usr/bin/env python3
"""
Trigger profile analyzer for setup flow.

Builds a v2 trigger profile from an outer crop:
- auto-detects inner bbox
- normalizes grayscale template
- computes thumbnail hash
- selects ORB or NCC mode based on keypoint count
"""

import argparse
import base64
import json
import os
import sys

import cv2
import numpy as np


ANALYZER_CONTRACT_VERSION = 2
NORMALIZED_TEMPLATE_SIZE = {'width': 128, 'height': 128}
HASH_SIZE = 8
KEYPOINT_THRESHOLD = 18
HASH_THRESHOLD = 18
ORB_DISTANCE_THRESHOLD = 55
ORB_MIN_GOOD_MATCHES = 10
NCC_THRESHOLD = 0.72


def validate_input(image_path):
    if not os.path.exists(image_path):
        return {'error': 'Файл не найден'}

    image = cv2.imread(image_path)
    if image is None:
        return {'error': 'Не удается прочитать изображение'}

    height, width = image.shape[:2]
    if height < 16 or width < 16:
        return {'error': f'Область слишком маленькая ({width}x{height}), минимум 16x16 пикселей'}

    if height > 4000 or width > 4000:
        return {'error': f'Область слишком большая ({width}x{height}), максимум 4000x4000 пикселей'}

    return {
        'valid': True,
        'image': image,
        'size': {'width': width, 'height': height},
    }


def get_dominant_colors(image, k=3):
    try:
        data = image.reshape((-1, 3)).astype(np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, labels, centers = cv2.kmeans(data, k, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)
        centers = np.uint8(centers)
        unique_labels, counts = np.unique(labels, return_counts=True)
        sorted_indices = np.argsort(-counts)
        return [centers[index].tolist() for index in sorted_indices]
    except Exception as error:  # pragma: no cover - defensive fallback
        print(f'WARNING: dominant colors failed: {error}', file=sys.stderr)
        return [[128, 128, 128], [64, 64, 64], [192, 192, 192]]


def normalize_channel(channel):
    channel = channel.astype(np.float32)
    min_value = float(channel.min())
    max_value = float(channel.max())
    if max_value - min_value < 1e-6:
        return np.zeros_like(channel, dtype=np.uint8)
    normalized = (channel - min_value) / (max_value - min_value)
    return np.clip(normalized * 255.0, 0, 255).astype(np.uint8)


def compute_inner_bbox(image, force_full_inner=False):
    height, width = image.shape[:2]
    full_bbox = {
        'x': 0,
        'y': 0,
        'width': width,
        'height': height,
    }

    if force_full_inner:
        return full_bbox, True, 1.0

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    border_size = max(4, min(width, height) // 12)
    border_pixels = np.concatenate([
        blurred[:border_size, :].ravel(),
        blurred[-border_size:, :].ravel(),
        blurred[:, :border_size].ravel(),
        blurred[:, -border_size:].ravel(),
    ])
    background_level = int(np.median(border_pixels)) if border_pixels.size else int(np.median(blurred))

    contrast_map = cv2.absdiff(blurred, np.full_like(blurred, background_level))
    grad_x = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    gradient_map = cv2.magnitude(grad_x, grad_y)

    combined = cv2.addWeighted(
        normalize_channel(contrast_map),
        0.55,
        normalize_channel(gradient_map),
        0.45,
        0,
    )

    threshold = max(32, int(np.percentile(combined, 74)))
    _, mask = cv2.threshold(combined, threshold, 255, cv2.THRESH_BINARY)

    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return full_bbox, True, 0.0

    largest = max(contours, key=cv2.contourArea)
    contour_area = cv2.contourArea(largest)
    if contour_area <= 0:
        return full_bbox, True, 0.0

    x, y, box_width, box_height = cv2.boundingRect(largest)
    padding = max(4, int(max(box_width, box_height) * 0.06))
    x = max(0, x - padding)
    y = max(0, y - padding)
    box_width = min(width - x, box_width + padding * 2)
    box_height = min(height - y, box_height + padding * 2)

    bbox_area = box_width * box_height
    area_ratio = bbox_area / float(width * height)

    if box_width < 16 or box_height < 16 or area_ratio < 0.08 or area_ratio > 0.96:
        return full_bbox, True, min(0.3, area_ratio)

    confidence = min(1.0, max(0.15, contour_area / max(float(bbox_area), 1.0)))
    return {
        'x': int(x),
        'y': int(y),
        'width': int(box_width),
        'height': int(box_height),
    }, False, float(confidence)


def crop_inner(image, inner_bbox):
    x = inner_bbox['x']
    y = inner_bbox['y']
    width = inner_bbox['width']
    height = inner_bbox['height']
    return image[y:y + height, x:x + width]


def normalize_grayscale(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.resize(
        gray,
        (NORMALIZED_TEMPLATE_SIZE['width'], NORMALIZED_TEMPLATE_SIZE['height']),
        interpolation=cv2.INTER_AREA,
    )


def encode_grayscale_base64(gray_image):
    success, encoded = cv2.imencode('.png', gray_image)
    if not success:
        raise RuntimeError('Не удалось закодировать grayscale template')
    return base64.b64encode(encoded.tobytes()).decode('utf-8')


def compute_ahash(gray_image):
    tiny = cv2.resize(gray_image, (HASH_SIZE, HASH_SIZE), interpolation=cv2.INTER_AREA)
    average = float(np.mean(tiny))
    bits = ''.join('1' if pixel >= average else '0' for pixel in tiny.flatten())
    hex_length = len(bits) // 4
    return f'{int(bits, 2):0{hex_length}x}'


def compute_keypoints_count(gray_image):
    orb = cv2.ORB_create(nfeatures=300)
    keypoints, _ = orb.detectAndCompute(gray_image, None)
    return len(keypoints or [])


def analyze_trigger_profile(image_path, force_full_inner=False):
    validation = validate_input(image_path)
    if 'error' in validation:
        return {'success': False, 'error': validation['error']}

    image = validation['image']
    outer_size = validation['size']
    aux_color_palette = get_dominant_colors(image, k=3)

    inner_bbox, used_full_outer, confidence = compute_inner_bbox(image, force_full_inner=force_full_inner)
    inner_image = crop_inner(image, inner_bbox)
    normalized_gray = normalize_grayscale(inner_image)
    thumbnail_hash = compute_ahash(normalized_gray)
    keypoints_count = compute_keypoints_count(normalized_gray)
    feature_mode = 'orb' if keypoints_count >= KEYPOINT_THRESHOLD else 'ncc'

    inner_ratio = {
        'x': round(inner_bbox['x'] / float(max(outer_size['width'], 1)), 6),
        'y': round(inner_bbox['y'] / float(max(outer_size['height'], 1)), 6),
        'width': round(inner_bbox['width'] / float(max(outer_size['width'], 1)), 6),
        'height': round(inner_bbox['height'] / float(max(outer_size['height'], 1)), 6),
    }

    return {
        'success': True,
        'contract_version': ANALYZER_CONTRACT_VERSION,
        'analyzer_version': 'trigger-profile-v2',
        'script_path': os.path.abspath(__file__),
        'inner_bbox': inner_bbox,
        'feature_mode': feature_mode,
        'keypoints_count': keypoints_count,
        'template_gray_base64': encode_grayscale_base64(normalized_gray),
        'thumbnail_hash': thumbnail_hash,
        'normalized_template_size': NORMALIZED_TEMPLATE_SIZE,
        'aux_color_palette': aux_color_palette,
        'color_palette': aux_color_palette,
        'analysis_info': {
            'outer_size': outer_size,
            'inner_size': {
                'width': inner_bbox['width'],
                'height': inner_bbox['height'],
            },
            'inner_ratio': inner_ratio,
            'auto_crop_confidence': round(confidence, 4),
            'used_full_outer': used_full_outer,
            'hash_threshold': HASH_THRESHOLD,
            'keypoint_threshold': KEYPOINT_THRESHOLD,
            'orb_distance_threshold': ORB_DISTANCE_THRESHOLD,
            'orb_min_good_matches': ORB_MIN_GOOD_MATCHES,
            'ncc_threshold': NCC_THRESHOLD,
        },
    }


def main():
    parser = argparse.ArgumentParser(description='Trigger profile analyzer')
    parser.add_argument('image_path', help='Путь к изображению outer ROI')
    parser.add_argument('--force-full-inner', action='store_true')
    args = parser.parse_args()

    try:
        result = analyze_trigger_profile(args.image_path, force_full_inner=args.force_full_inner)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get('success') else 1)
    except Exception as error:  # pragma: no cover - CLI safety net
        print(json.dumps({
            'success': False,
            'error': f'Критическая ошибка: {error}',
        }, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
