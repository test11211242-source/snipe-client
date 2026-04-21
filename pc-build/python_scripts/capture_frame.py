#!/usr/bin/env python3
"""
One-shot frame capture helper for setup flow.

Captures a single frame from the same windows_capture backend used by runtime
monitoring and returns it as JSON with base64 PNG payload.
"""

import argparse
import base64
import json
import sys
import threading

import cv2
import windows_capture


def encode_png_base64(image):
    success, encoded = cv2.imencode('.png', image)
    if not success:
        raise RuntimeError('Не удалось закодировать кадр в PNG')
    return base64.b64encode(encoded.tobytes()).decode('utf-8')


class OneShotCapture:
    def __init__(self, target_type, target_id, hide_capture_border=False):
        self.target_type = target_type
        self.target_id = target_id
        self.hide_capture_border = hide_capture_border
        self.done_event = threading.Event()
        self.capture_result = None
        self.capture_error = None
        self.capture_control = None

        if target_type == 'window':
            if hide_capture_border:
                self.capturer = windows_capture.WindowsCapture(window_name=target_id, draw_border=False)
            else:
                self.capturer = windows_capture.WindowsCapture(window_name=target_id)
        else:
            monitor_index = int(target_id) + 1
            if hide_capture_border:
                self.capturer = windows_capture.WindowsCapture(monitor_index=monitor_index, draw_border=False)
            else:
                self.capturer = windows_capture.WindowsCapture(monitor_index=monitor_index)

    def run(self, timeout_seconds=4.0):
        @self.capturer.event
        def on_frame_arrived(frame, capture_control):
            if self.capture_result is not None:
                return

            try:
                frame_buffer = frame.frame_buffer
                if len(frame_buffer.shape) == 3 and frame_buffer.shape[2] == 4:
                    frame_buffer = frame_buffer[:, :, :3]

                image_b64 = encode_png_base64(frame_buffer)
                self.capture_result = {
                    'success': True,
                    'image_base64': image_b64,
                    'frame_size': {
                        'width': int(frame.width),
                        'height': int(frame.height),
                    },
                }
            except Exception as error:  # pragma: no cover - best effort helper
                self.capture_error = str(error)
            finally:
                try:
                    capture_control.stop()
                except Exception:
                    pass
                self.done_event.set()

        @self.capturer.event
        def on_closed():
            if self.capture_result is None and self.capture_error is None:
                self.capture_error = 'Сессия захвата была закрыта до получения кадра'
            self.done_event.set()

        self.capture_control = self.capturer.start_free_threaded()

        if not self.done_event.wait(timeout_seconds):
            try:
                self.capture_control.stop()
            except Exception:
                pass
            self.capture_error = f'Не удалось получить кадр за {timeout_seconds:.1f}с'

        try:
            self.capture_control.wait()
        except Exception:
            pass

        if self.capture_result is not None:
            return self.capture_result

        return {
            'success': False,
            'error': self.capture_error or 'Не удалось получить кадр',
        }


def main():
    parser = argparse.ArgumentParser(description='One-shot frame capture helper')
    parser.add_argument('--target_type', required=True, choices=['window', 'screen'])
    parser.add_argument('--target_id', required=True)
    parser.add_argument('--hide_capture_border', action='store_true')
    parser.add_argument('--timeout', type=float, default=4.0)
    args = parser.parse_args()

    try:
        capture = OneShotCapture(
            target_type=args.target_type,
            target_id=args.target_id,
            hide_capture_border=args.hide_capture_border,
        )
        result = capture.run(timeout_seconds=args.timeout)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get('success') else 1)
    except Exception as error:
        print(json.dumps({
            'success': False,
            'error': str(error),
        }, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
