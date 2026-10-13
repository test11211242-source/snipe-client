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

`analyze_trigger.py` accepts the canonical PNG, a source-pixel outer rectangle and
nullable `gameRect` in protocol 2. It always returns the existing structural `profile`
and `legacyProfile`; `vsOrientation`/`vsBadge` are populated only when the marked area
contains the VS badge and its silhouette passes M9 acceptance. No temporary image
files are created. Main-process protocol 2 consumption is part of M9 A4.

`monitor_engine.py` is the M4 persistent worker. It reads bounded protocol-version-1
JSON-lines from stdin and emits session-bound monotonic JSON-lines on stdout. The only event
that may contain base64 is the private `action` event. Diagnostics never include selectors,
window titles, configuration, or images. The worker validates the complete profile, ratios,
fixed trigger thresholds, and image limits before constructing the isolated Windows backend,
uses `start_free_threaded`, and emits `ready` only after its first valid frame.

## M9 A1 geometry and offline replay

`geometry/` implements game-border peeling, temporally static chrome trimming,
colour-free coarse/fine VS edge-orientation search, three-frame confirmation,
game-relative zones, the silhouette orientation trigger (rule c), Q8 templates and
shared acceptance/self-checks. It does not change the monitoring engine.
`prepared_capture.py` retains eight samples at least 300 ms apart and adds a `game`
result to `frozen`; insufficient, unsupported or unstable geometry is explicit.
Prepared capture remains protocol 1 until the live-analysis commands in M9 B2.

`assets/vs_badge_v1*.png` contain only the approved badge and silhouette, with no
player names. `tools/make_vs_badge_asset.py <external-3.png>` is the one-time offline
authoring tool; its HSV mask generation is not a runtime colour comparison.
Portable packaging explicitly includes the assets and geometry modules, and
`npm run runtime:verify` checks their presence, packaging filters and decoding.

`tools/m9_replay.py {setup|orient} --manifest <external.json> --out <external-dir>`
runs all 17 reference distortions. The manifest format is documented in its
docstring. `--prototype-jpeg92` matches the prototype's in-memory extraction codec.
Replay never saves frames unless `--overlays` is requested, refuses output inside
a Git repository, and writes numeric/code-only `results.json`.
`npm run test:python` excludes `replay` tests; run them explicitly with
`CR_M9_REPLAY_MANIFEST` and `python -m pytest tests -m replay`.
Replay output identifies its sampling convention and includes explicit acceptance
results; a failed replay exits nonzero. Director-approved regression bounds are
minimum stable rule-(c) VS score ≥0.70 under the worst distortion, non-VS maximum
≤0.30, and spectate rejection by the layout check. The prototype's measured 0.74
minimum is not a production threshold: `ORIENT_T=0.50` and setup self-check bounds
(VS ≥0.50, pre-VS <0.30) remain unchanged.
