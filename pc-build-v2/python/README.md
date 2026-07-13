# Capture Worker Protocol

M3 pins `windows-capture==2.0.0`. Workers receive and return one `CRT2` envelope on
standard input/output. The 12-byte big-endian header is `magic[4]`, JSON metadata
length `uint32`, and binary length `uint32`, followed by UTF-8 JSON and binary data.
Every worker validates its operation, protocol version, request ID, exact metadata
fields, and operation-specific byte limits. Standard error is reserved for process
diagnostics; screenshots and selectors must never be logged.

`capture_once.py` accepts no request binary and returns one PNG. Window selectors use
an HWND decimal string and `window_hwnd`. Display selectors use a Windows device name;
Python resolves that exact name during monitor enumeration before passing the resulting
index to the pinned backend. There is no primary-monitor or first-source fallback.

`analyze_trigger.py` accepts the canonical PNG and a source-pixel outer rectangle. It
returns a 128x128 grayscale profile, bitwise `ahash64`, automatic inner crop, and an
ORB/NCC feature selection. No temporary image files are created.

`monitor_engine.py` is the M4 persistent worker. It reads bounded protocol-version-1
JSON-lines from stdin and emits session-bound monotonic JSON-lines on stdout. The only event
that may contain base64 is the private `action` event. Diagnostics never include selectors,
window titles, configuration, or images. The worker validates the complete profile, ratios,
fixed trigger thresholds, and image limits before constructing the isolated Windows backend,
uses `start_free_threaded`, and emits `ready` only after its first valid frame.
