#!/usr/bin/env python3
"""
Unified trigger engine for screen/window monitoring.

Pipeline:
outer ROI -> inner ROI normalization -> grayscale hash precheck ->
structural confirm (ORB or NCC) -> soft confirmations
"""

import argparse
import base64
import json
import sys
import time
from datetime import datetime

import cv2
import numpy as np
import windows_capture


def clamp_rect(rect, frame_width, frame_height):
    x = max(0, min(int(rect['x']), max(frame_width - 1, 0)))
    y = max(0, min(int(rect['y']), max(frame_height - 1, 0)))
    width = max(1, int(rect['width']))
    height = max(1, int(rect['height']))

    if x + width > frame_width:
        width = max(1, frame_width - x)
    if y + height > frame_height:
        height = max(1, frame_height - y)

    return {
        'x': x,
        'y': y,
        'width': width,
        'height': height,
    }


def ratio_to_rect(ratio, frame_width, frame_height, parent_rect=None):
    if parent_rect is None:
        base_x = 0
        base_y = 0
        base_width = frame_width
        base_height = frame_height
    else:
        base_x = parent_rect['x']
        base_y = parent_rect['y']
        base_width = parent_rect['width']
        base_height = parent_rect['height']

    rect = {
        'x': base_x + int(round(ratio['x'] * base_width)),
        'y': base_y + int(round(ratio['y'] * base_height)),
        'width': max(1, int(round(ratio['width'] * base_width))),
        'height': max(1, int(round(ratio['height'] * base_height))),
    }
    return clamp_rect(rect, frame_width, frame_height)


def crop_rect(image, rect):
    return image[rect['y']:rect['y'] + rect['height'], rect['x']:rect['x'] + rect['width']]


def ensure_bgr(image):
    if len(image.shape) == 3 and image.shape[2] == 4:
        return image[:, :, :3]
    return image


def normalize_grayscale(image, normalized_size):
    bgr = ensure_bgr(image)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return cv2.resize(
        gray,
        (int(normalized_size['width']), int(normalized_size['height'])),
        interpolation=cv2.INTER_AREA,
    )


def decode_gray_template(b64_string):
    image_bytes = base64.b64decode(b64_string)
    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    template = cv2.imdecode(image_array, cv2.IMREAD_GRAYSCALE)
    if template is None:
        raise RuntimeError('Не удалось декодировать template_gray_base64')
    return template


def compute_ahash(gray_image):
    tiny = cv2.resize(gray_image, (8, 8), interpolation=cv2.INTER_AREA)
    average = float(np.mean(tiny))
    bits = ''.join('1' if pixel >= average else '0' for pixel in tiny.flatten())
    return f'{int(bits, 2):016x}'


def hamming_distance(hash_a, hash_b):
    if not hash_a or not hash_b:
        return 64
    return sum(ch_a != ch_b for ch_a, ch_b in zip(hash_a, hash_b))


def encode_png_base64(image):
    success, encoded = cv2.imencode('.png', ensure_bgr(image))
    if not success:
        raise RuntimeError('Не удалось закодировать кадр в PNG')
    return base64.b64encode(encoded.tobytes()).decode('utf-8')


class TriggerProfile:
    def __init__(self, config):
        self.id = config['id']
        self.profile_type = config.get('profile_type', 'generic')
        self.action_type = config.get('action_type', 'capture_and_send')
        self.outer_ratio = config['outer_ratio']
        self.inner_ratio = config['inner_ratio']
        self.data_capture_ratio = config['data_capture_ratio']
        self.cooldown = float(config.get('cooldown', 15))
        self.confirmations_needed = float(config.get('confirmations_needed', 2))
        self.confirmation_decay = float(config.get('confirmation_decay', 0.5))
        self.capture_delay = float(config.get('capture_delay', 0))
        self.hide_capture_border = config.get('hideCaptureBorder', False)

        self.feature_mode = config.get('feature_mode', 'ncc')
        self.thumbnail_hash = config.get('thumbnail_hash', '')
        self.hash_max_distance = int(config.get('hash_max_distance', 18))
        self.orb_distance_threshold = int(config.get('orb_distance_threshold', 55))
        self.orb_min_good_matches = int(config.get('orb_min_good_matches', 10))
        self.ncc_min_score = float(config.get('ncc_min_score', 0.72))
        self.keypoints_count = int(config.get('keypoints_count', 0))
        self.normalized_template_size = config.get('normalized_template_size', {'width': 128, 'height': 128})
        self.source_frame_size = config.get('source_frame_size')

        self.current_confirmations = 0.0
        self.last_triggered_time = 0.0

        self.template_gray = decode_gray_template(config['template_gray_base64'])
        self.template_keypoints = None
        self.template_descriptors = None

        if self.feature_mode == 'orb':
            orb = cv2.ORB_create(nfeatures=400)
            self.template_keypoints, self.template_descriptors = orb.detectAndCompute(self.template_gray, None)


class ScreenMonitor:
    def __init__(self, target_type, target_id, profiles_config, target_fps=10):
        self.orb = cv2.ORB_create(nfeatures=400)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        self.triggers = [TriggerProfile(profile) for profile in profiles_config]

        if not self.triggers:
            raise RuntimeError('Не передано ни одного trigger profile')

        self.hide_capture_border = profiles_config[0].get('hideCaptureBorder', False)
        self.target_type = target_type
        self.target_id = target_id
        self.target_fps = target_fps
        self.frame_interval = 1.0 / target_fps if target_fps > 0 else 0.0
        self.last_processed_time = 0.0
        self.pending_actions = []
        self.ready_announced = False
        self.capturer = self._create_capturer(target_type, target_id)

    def _create_capturer(self, target_type, target_id):
        try:
            if target_type == 'window':
                if not self._validate_window_exists(target_id):
                    print(f"ERROR:Target window '{target_id}' not found or unavailable", file=sys.stderr)
                    print(f"STATUS:Available windows: {self._get_available_windows()}", file=sys.stderr)
                    sys.exit(1)

                if self.hide_capture_border:
                    return windows_capture.WindowsCapture(window_name=target_id, draw_border=False)
                return windows_capture.WindowsCapture(window_name=target_id)

            monitor_index = int(target_id) + 1
            if self.hide_capture_border:
                return windows_capture.WindowsCapture(monitor_index=monitor_index, draw_border=False)
            return windows_capture.WindowsCapture(monitor_index=monitor_index)
        except Exception as error:
            print(f'ERROR: Failed to create capturer: {error}', file=sys.stderr)
            sys.exit(1)

    def _validate_window_exists(self, window_name):
        try:
            import win32gui

            matches = []

            def enum_windows_proc(hwnd, result):
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd)
                    if title and window_name.lower() in title.lower():
                        result.append((hwnd, title))
                return True

            win32gui.EnumWindows(enum_windows_proc, matches)
            return bool(matches)
        except ImportError:
            return True
        except Exception as error:
            print(f'ERROR: Window validation failed: {error}', file=sys.stderr)
            return False

    def _get_available_windows(self):
        try:
            import win32gui

            windows = []

            def enum_windows_proc(hwnd, result):
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd)
                    if title and title.strip():
                        result.append(title)
                return True

            win32gui.EnumWindows(enum_windows_proc, windows)
            return windows[:10]
        except Exception:
            return []

    def _setup_event_handlers(self):
        @self.capturer.event
        def on_frame_arrived(frame, capture_control):
            self._on_frame_arrived(frame, capture_control)

        @self.capturer.event
        def on_closed():
            self._on_closed()

    def _on_closed(self):
        print('STATUS:Screen capture stopped', flush=True)

    def _emit_debug(self, payload):
        print(f'DEBUG_JSON:{json.dumps(payload, ensure_ascii=False)}', flush=True)

    def _evaluate_orb(self, normalized_gray, trigger):
        keypoints, descriptors = self.orb.detectAndCompute(normalized_gray, None)
        current_keypoints = len(keypoints or [])

        if trigger.template_descriptors is None or descriptors is None or current_keypoints == 0:
            return {
                'passed': False,
                'current_keypoints': current_keypoints,
                'total_matches': 0,
                'good_matches': 0,
                'reason': 'orb_descriptors_missing',
            }

        matches = self.matcher.match(trigger.template_descriptors, descriptors)
        matches = sorted(matches, key=lambda match: match.distance)
        good_matches = [match for match in matches if match.distance <= trigger.orb_distance_threshold]

        return {
            'passed': len(good_matches) >= trigger.orb_min_good_matches,
            'current_keypoints': current_keypoints,
            'total_matches': len(matches),
            'good_matches': len(good_matches),
            'reason': 'pass' if len(good_matches) >= trigger.orb_min_good_matches else 'orb_insufficient_matches',
        }

    def _evaluate_ncc(self, normalized_gray, trigger):
        score = float(cv2.matchTemplate(normalized_gray, trigger.template_gray, cv2.TM_CCOEFF_NORMED)[0][0])
        return {
            'passed': score >= trigger.ncc_min_score,
            'score': score,
            'reason': 'pass' if score >= trigger.ncc_min_score else 'ncc_below_threshold',
        }

    def _evaluate_trigger(self, full_img, trigger):
        frame_height, frame_width = full_img.shape[:2]
        outer_rect = ratio_to_rect(trigger.outer_ratio, frame_width, frame_height)
        inner_rect = ratio_to_rect(trigger.inner_ratio, frame_width, frame_height, parent_rect=outer_rect)

        inner_crop = crop_rect(full_img, inner_rect)
        if inner_crop.size == 0:
            confidence_before = trigger.current_confirmations
            confidence_after = max(0.0, confidence_before - trigger.confirmation_decay)
            trigger.current_confirmations = confidence_after
            debug_payload = {
                'id': trigger.id,
                'frame_size': {'width': frame_width, 'height': frame_height},
                'source_frame_size': trigger.source_frame_size,
                'outer_roi': outer_rect,
                'inner_roi': inner_rect,
                'feature_mode': trigger.feature_mode,
                'confidence_before': confidence_before,
                'confidence_after': confidence_after,
                'passed': False,
                'reason': 'inner_roi_empty',
            }
            self._emit_debug(debug_payload)
            return False

        normalized_gray = normalize_grayscale(inner_crop, trigger.normalized_template_size)
        current_hash = compute_ahash(normalized_gray)
        hash_distance = hamming_distance(current_hash, trigger.thumbnail_hash)
        confidence_before = trigger.current_confirmations

        if hash_distance > trigger.hash_max_distance:
            confidence_after = max(0.0, confidence_before - trigger.confirmation_decay)
            trigger.current_confirmations = confidence_after
            self._emit_debug({
                'id': trigger.id,
                'frame_size': {'width': frame_width, 'height': frame_height},
                'source_frame_size': trigger.source_frame_size,
                'outer_roi': outer_rect,
                'inner_roi': inner_rect,
                'feature_mode': trigger.feature_mode,
                'hash_distance': hash_distance,
                'hash_threshold': trigger.hash_max_distance,
                'confidence_before': confidence_before,
                'confidence_after': confidence_after,
                'passed': False,
                'reason': 'hash_precheck_failed',
            })
            return False

        structural = self._evaluate_orb(normalized_gray, trigger) if trigger.feature_mode == 'orb' else self._evaluate_ncc(normalized_gray, trigger)
        passed = structural['passed']
        confidence_after = min(trigger.confirmations_needed, confidence_before + 1.0) if passed else max(0.0, confidence_before - trigger.confirmation_decay)
        trigger.current_confirmations = confidence_after

        debug_payload = {
            'id': trigger.id,
            'frame_size': {'width': frame_width, 'height': frame_height},
            'source_frame_size': trigger.source_frame_size,
            'outer_roi': outer_rect,
            'inner_roi': inner_rect,
            'normalized_size': trigger.normalized_template_size,
            'feature_mode': trigger.feature_mode,
            'hash_distance': hash_distance,
            'hash_threshold': trigger.hash_max_distance,
            'confidence_before': confidence_before,
            'confidence_after': confidence_after,
            'passed': passed,
            'reason': structural['reason'],
        }

        if trigger.feature_mode == 'orb':
            debug_payload['orb'] = {
                'current_keypoints': structural['current_keypoints'],
                'template_keypoints': len(trigger.template_keypoints or []),
                'total_matches': structural['total_matches'],
                'good_matches': structural['good_matches'],
                'distance_threshold': trigger.orb_distance_threshold,
                'min_good_matches': trigger.orb_min_good_matches,
            }
        else:
            debug_payload['ncc'] = {
                'score': structural['score'],
                'threshold': trigger.ncc_min_score,
            }

        self._emit_debug(debug_payload)
        return passed and confidence_after >= trigger.confirmations_needed

    def _has_pending_action(self, trigger_id):
        return any(action['trigger'].id == trigger_id for action in self.pending_actions)

    def _perform_capture(self, trigger, full_img):
        try:
            frame_height, frame_width = full_img.shape[:2]
            data_rect = ratio_to_rect(trigger.data_capture_ratio, frame_width, frame_height)
            data_img = crop_rect(full_img, data_rect)
            if data_img.size == 0:
                print(f'ERROR:Пустая область данных для {trigger.id}', file=sys.stderr)
                return

            action_data = {
                'id': trigger.id,
                'profile_type': trigger.profile_type,
                'action_type': trigger.action_type,
                'timestamp': datetime.now().isoformat(),
                'image_b64': encode_png_base64(data_img),
                'capture_delay': trigger.capture_delay,
                'region': data_rect,
            }

            print(f'ACTION_DATA:{json.dumps(action_data, ensure_ascii=False)}', flush=True)
            print(f"STATUS:Данные для '{trigger.id}' захвачены и отправлены", flush=True)
        except Exception as error:
            print(f'ERROR: Ошибка выполнения захвата для {trigger.id}: {error}', file=sys.stderr)

    def _on_frame_arrived(self, frame, capture_control):
        current_time = time.time()
        if current_time - self.last_processed_time < self.frame_interval:
            return

        self.last_processed_time = current_time
        full_img = ensure_bgr(frame.frame_buffer)

        if not self.ready_announced:
            frame_height, frame_width = full_img.shape[:2]
            ready_payload = {
                'target_type': self.target_type,
                'target_id': self.target_id,
                'profiles': [trigger.id for trigger in self.triggers],
                'frame_size': {
                    'width': frame_width,
                    'height': frame_height,
                },
            }
            print(f'ENGINE_READY:{json.dumps(ready_payload, ensure_ascii=False)}', flush=True)
            print('STATUS:Trigger engine ready', flush=True)
            self.ready_announced = True

        for trigger in self.triggers:
            if current_time - trigger.last_triggered_time < trigger.cooldown:
                continue

            ready_to_fire = self._evaluate_trigger(full_img, trigger)
            if not ready_to_fire:
                continue

            print(f'TRIGGER_FIRED:{json.dumps({"id": trigger.id, "action_type": trigger.action_type}, ensure_ascii=False)}', flush=True)

            if trigger.capture_delay > 0:
                if not self._has_pending_action(trigger.id):
                    print(f'STATUS:Ожидание {trigger.capture_delay}с для загрузки полных данных...', flush=True)
                    self.pending_actions.append({
                        'trigger': trigger,
                        'ready_time': current_time + trigger.capture_delay,
                    })
            else:
                self._perform_capture(trigger, full_img)

            trigger.last_triggered_time = current_time
            trigger.current_confirmations = 0.0

        for action in list(self.pending_actions):
            if current_time >= action['ready_time']:
                self._perform_capture(action['trigger'], full_img)
                self.pending_actions.remove(action)

    def run(self):
        print('STATUS:Setting up event handlers...', flush=True)
        self._setup_event_handlers()
        self.capturer.start()


def main():
    parser = argparse.ArgumentParser(description='Unified screen monitor with trigger profiles')
    parser.add_argument('--target_type', required=True, choices=['window', 'screen'])
    parser.add_argument('--target_id', required=True)
    parser.add_argument('--profiles_file', required=True)
    parser.add_argument('--fps', type=int, default=10)
    args = parser.parse_args()

    try:
        with open(args.profiles_file, 'r', encoding='utf-8') as profiles_file:
            profiles_config = json.load(profiles_file)

        if not isinstance(profiles_config, list) or not profiles_config:
            print('ERROR: Profiles must be a non-empty array', file=sys.stderr)
            sys.exit(1)

        monitor = ScreenMonitor(args.target_type, args.target_id, profiles_config, target_fps=args.fps)
        monitor.run()
    except KeyboardInterrupt:
        print('STATUS:Monitoring stopped by user', flush=True)
    except json.JSONDecodeError as error:
        print(f'ERROR: Invalid JSON in profiles: {error}', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
