from types import SimpleNamespace

import numpy as np
import pytest

import monitor_engine as monitor
from trigger_engine import GeometryChangedError


@pytest.mark.parametrize('stage,code', [
    ('trigger', 'MONITOR_INTERNAL_FAILED'),
    ('backend', 'CAPTURE_START_FAILED'),
    ('start', 'CAPTURE_START_FAILED'),
    ('invalid', 'CAPTURE_FRAME_INVALID'),
    ('invalid-dtype', 'CAPTURE_FRAME_INVALID'),
    ('geometry', 'CAPTURE_GEOMETRY_CHANGED'),
    ('closed', 'CAPTURE_SOURCE_CLOSED'),
    ('internal', 'MONITOR_INTERNAL_FAILED'),
    ('no-frame', 'CAPTURE_NO_FRAME'),
    ('stop', None),
    ('stop-constructor', None),
    ('writer', None),
])
def test_guarded_lifecycle(monkeypatch, stage, code):
    events = []
    stopped = []
    readers = []

    class Writer:
        sequence = 0
        def __init__(self, _session):
            pass
        def emit(self, event_type, payload):
            self.sequence += 1
            if stage == 'writer':
                raise OSError('private diagnostic')
            events.append((event_type, payload))

    def engine(_payload):
        if stage == 'trigger':
            raise ValueError('private constructor diagnostic')
        if stage == 'stop-constructor':
            readers[0]()
        def process(_frame, _now):
            if stage == 'geometry':
                raise GeometryChangedError('private geometry diagnostic')
            if stage == 'internal':
                raise ValueError('private internal diagnostic')
            return None
        return SimpleNamespace(process=process, last_match=None, take_triggered=lambda: False,
                               take_events=lambda: [])


    class Backend:
        def __init__(self, _selector):
            if stage == 'backend':
                raise ValueError('private backend diagnostic')
        def start(self, frame, closed):
            if stage == 'start':
                raise ValueError('private start diagnostic')
            if stage == 'stop':
                readers[0]()
            elif stage == 'invalid':
                frame(np.zeros((2, 2), dtype=np.uint8))
            elif stage == 'invalid-dtype':
                frame(np.zeros((2, 2, 3), dtype=np.float32))
            elif stage in ('geometry', 'internal', 'writer'):
                frame(np.zeros((2, 2, 3), dtype=np.uint8))
            elif stage == 'closed':
                closed()
                closed()
        def stop(self):
            stopped.append(True)
            raise RuntimeError('private cleanup diagnostic')

    class Reader:
        def __init__(self, target, **_kwargs):
            readers.append(target)
        def start(self):
            pass

    monkeypatch.setattr(monitor, 'EventWriter', Writer)
    monkeypatch.setattr(monitor, 'TriggerEngine', engine)
    monkeypatch.setattr(monitor, 'WindowsMonitorBackend', Backend)
    monkeypatch.setattr(monitor.threading, 'Thread', Reader)
    monkeypatch.setattr(monitor, 'read_command', lambda *_args, **_kwargs: {'type': 'stop'})
    times = iter([0.0, 20.0, 40.0, 60.0])
    monkeypatch.setattr(monitor.time, 'monotonic', lambda: next(times))
    result = monitor.run({'sessionId': 'test', 'payload': {
        'selector': {},
        'limits': {'maxImagePixels': 20_000_000},
    }})
    fatal = [payload for event_type, payload in events if event_type == 'fatal']
    assert len(fatal) == (1 if code else 0)
    if code:
        assert fatal[0]['code'] == code
    assert 'private' not in repr(events)
    assert len(stopped) == (0 if stage in ('trigger', 'backend', 'stop-constructor') else 1)
    assert result == (2 if stage == 'writer' else 0)


def test_diagnostics_are_written_only_when_the_match_state_changes(monkeypatch):
    events = []
    states = iter([(False, 'no_candidate'), (False, 'no_candidate'), (True, 'pass'), (True, 'pass'),
                   (False, 'structure_below_threshold'), (False, 'structure_below_threshold')])

    class Writer:
        sequence = 0
        def __init__(self, _session):
            pass
        def emit(self, event_type, payload):
            self.sequence += 1
            events.append((event_type, payload))

    def engine(_payload):
        state = SimpleNamespace(last_match=None)
        def process(_frame, _now):
            matched, reason = next(states)
            state.last_match = SimpleNamespace(matcher='vs_orientation', matched=matched, score=0.4 + matched * 0.5,
                                               support=None, orientation=0.4, correlation=None,
                                               orb_inliers=None, reason=reason)
            return None
        state.process = process
        state.take_triggered = lambda: False
        state.take_events = lambda: []
        return state

    class Backend:
        def __init__(self, _selector):
            pass
        def start(self, frame, _closed):
            for _ in range(6):
                frame(np.zeros((2, 2, 3), dtype=np.uint8))
            readers[0]()
        def stop(self):
            pass

    readers = []

    class Reader:
        def __init__(self, target, **_kwargs):
            readers.append(target)
        def start(self):
            pass

    monkeypatch.setattr(monitor, 'EventWriter', Writer)
    monkeypatch.setattr(monitor, 'TriggerEngine', engine)
    monkeypatch.setattr(monitor, 'WindowsMonitorBackend', Backend)
    monkeypatch.setattr(monitor.threading, 'Thread', Reader)
    monkeypatch.setattr(monitor, 'read_command', lambda *_args, **_kwargs: {'type': 'stop'})
    assert monitor.run({'sessionId': 'test', 'payload': {
        'selector': {}, 'limits': {'maxImagePixels': 20_000_000},
    }}) == 0
    diagnostics = [payload for event_type, payload in events if event_type == 'diagnostic']
    assert [(item['matched'], item['reason']) for item in diagnostics] == [
        (False, 'no_candidate'), (True, 'pass'), (False, 'structure_below_threshold')]


def test_minimised_window_pauses_analysis_and_reports_both_transitions(monkeypatch):
    events, processed, captured, readers = [], [], {}, []
    frame = np.zeros((2, 2, 3), dtype=np.uint8)

    class Writer:
        sequence = 0
        def __init__(self, _session):
            pass
        def emit(self, event_type, payload):
            self.sequence += 1
            events.append((event_type, payload))

    def engine(_payload):
        def process(_frame, _now):
            processed.append(True)
            return None
        return SimpleNamespace(process=process, last_match=None, take_triggered=lambda: False,
                               take_events=lambda: [])

    class Backend:
        def __init__(self, _selector):
            pass
        def start(self, on_frame, _closed):
            captured['frame'] = on_frame
            on_frame(frame)
        def stop(self):
            pass

    class Reader:
        def __init__(self, target, **_kwargs):
            readers.append(target)
        def start(self):
            pass

    polls = iter([False, True, True, False, False])

    def probe():
        state = next(polls, None)
        if state is None:
            readers[0]()
            return False
        last = [payload for event_type, payload in events if event_type == 'source_state'][-1:]
        if last:
            # While minimised the frame is skipped; once restored it is analysed again.
            captured['frame'](frame)
        return state

    monkeypatch.setattr(monitor, 'EventWriter', Writer)
    monkeypatch.setattr(monitor, 'TriggerEngine', engine)
    monkeypatch.setattr(monitor, 'WindowsMonitorBackend', Backend)
    monkeypatch.setattr(monitor, 'window_iconic_probe', lambda selector: probe)
    monkeypatch.setattr(monitor, 'ICONIC_POLL_SECONDS', 0)
    monkeypatch.setattr(monitor.threading, 'Thread', Reader)
    monkeypatch.setattr(monitor, 'read_command', lambda *_args, **_kwargs: {'type': 'stop'})
    assert monitor.run({'sessionId': 'test', 'payload': {
        'selector': {'kind': 'window', 'windowHwnd': '1'},
        'limits': {'maxImagePixels': 20_000_000},
    }}) == 0
    states = [payload for event_type, payload in events if event_type == 'source_state']
    assert states == [{'minimized': True}, {'minimized': False}]
    # The ready frame plus one frame after restore; the two frames while minimised are skipped.
    assert len(processed) == 2
    captured['frame'](frame)
    assert len(processed) == 2  # stopped: no analysis after stop either


@pytest.mark.parametrize("kind", ["battle", "spectate", None])
def test_primary_trigger_emits_identity_kind_and_reserved_rank_without_result_detection(monkeypatch, kind):
    events, readers = [], []
    image = b"nickname image"
    frame = np.zeros((2, 2, 3), dtype=np.uint8)

    class Writer:
        sequence = 0
        def __init__(self, _session):
            pass
        def emit(self, event_type, payload):
            self.sequence += 1
            events.append((event_type, payload))

    state = SimpleNamespace(
        process=lambda _frame, _now: (image, 2, 2), last_match=None,
        take_triggered=lambda: True, triggered_kind=kind, take_events=lambda: [],
    )
    initialized = []

    def engine(payload):
        initialized.append(payload)
        return state

    class Backend:
        def __init__(self, _selector):
            pass
        def start(self, on_frame, _closed):
            on_frame(frame)
            readers[0]()
        def stop(self):
            pass

    class Reader:
        def __init__(self, target, **_kwargs):
            readers.append(target)
        def start(self):
            pass

    monkeypatch.setattr(monitor, "EventWriter", Writer)
    monkeypatch.setattr(monitor, "TriggerEngine", engine)
    monkeypatch.setattr(monitor, "WindowsMonitorBackend", Backend)
    monkeypatch.setattr(monitor, "window_iconic_probe", lambda _selector: None)
    monkeypatch.setattr(monitor.threading, "Thread", Reader)
    monkeypatch.setattr(monitor, "read_command", lambda *_args, **_kwargs: {"type": "stop"})
    payload = {"selector": {}, "limits": {"maxImagePixels": 20_000_000}}
    assert monitor.run({"sessionId": "test", "payload": payload}) == 0
    assert initialized == [payload]
    assert [event_type for event_type, _ in events] == ["ready", "triggered", "action", "stopped"]
    triggered = events[1][1]
    assert triggered["kind"] == kind
    assert triggered["rank"] == "unknown"
    assert triggered["rankEvidence"] is None
    assert set(triggered) == {"timestamp", "triggerId", "kind", "rank", "rankEvidence"}
    action = events[2][1]
    assert action["triggerId"] == triggered["triggerId"]
    assert action["timestamp"] == triggered["timestamp"]
    assert action["byteLength"] == len(image)
