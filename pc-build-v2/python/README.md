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

`capture_sources.py` serves the source picker and does not use the `CRT2` envelope: one
JSON request on stdin (`displays`, `windows` with HWND decimal strings, or `previews`
with a maximum size), JSON lines on stdout. Display bounds are physical pixels
(per-monitor DPI aware); window identity is the owner PID and `<ProcessName>.exe` from
one process snapshot; previews are DWM `PrintWindow` captures encoded as JPEG, written
one window at a time with status `ok`, `unavailable` (closed/minimized) or `failed`.
Only `previews` imports numpy/OpenCV.

`monitor_engine.py` is the persistent worker. It reads bounded protocol-version-4
JSON-lines (1 MiB maximum) from stdin and emits session-bound monotonic JSON-lines
on stdout. `start.primary` selects unchanged legacy `full_frame` matching or the
M9 `game_relative` runtime. Diagnostics never include selectors, window titles,
configuration, or images; image-bearing `action` and private learned-layout
templates are forwarded only to main. The worker validates profiles, ratios,
fixed trigger thresholds, and image limits before constructing the isolated Windows backend,
uses `start_free_threaded`, and emits `ready` only after its first valid frame.

## M9 geometry, runtime and offline replay

`geometry/` implements game-border peeling, temporally static chrome trimming,
colour-free coarse/fine VS edge-orientation search, three-frame confirmation,
game-relative zones, the silhouette orientation trigger (rule c), Q8 templates and
shared acceptance/self-checks.
`prepared_capture.py` retains eight samples at least 300 ms apart and adds a `game`
result to `frozen`; insufficient, unsupported or unstable geometry is explicit.
Prepared capture remains protocol 1 until the live-analysis commands in M9 B2.

`game_geometry.py` tracks the game rectangle across window resizing and OBS
same-canvas scaling, subtracts matching saved chrome, and arms the closest saved
layout within a 4.5% aspect gap (`max(a/b, b/a) - 1`); a layout already armed for
the frame size is kept up to 6% when nothing else matches, because the peel drops
or regains uniform game rows as screens change. Layouts of one profile stay more
than 3% apart, so a game learned beyond 4.5% is never refused as an overlap and
MuMu F11 (gap 1.030) arms the windowed layout on every restart. Chrome whose
saved template no longer matches after a
window resize (fixed-size title-bar icons), or that a fullscreen profile never
saved, is inferred from the layout aspect, snapped to its full-width edge and
confirmed by the saved thickness or by a static band above a moving game. A band
on the frame's own edge must also continue through uniform letterbox bars peeled
off the perpendicular sides (window chrome spans the whole window): a still menu
column inside an emulator's fullscreen bars is game content, not a toolbar.
An inferred band stays a hypothesis: every detection re-proves it on the current
raw rect and drops it when the raw edge on its side moves more than 2 px (chrome
hangs on the window edge; a peeled dark game margin does not), when it no longer
crosses the letterbox bars, or when the band shows game motion on rechecks at
least a second apart. Only setup layouts and learned layouts without
template-less chrome imply a band: a learned layout whose chrome has no edge
template was learned through a phantom band (owner F11, 17.10.2026: a 96-px left
"toolbar" stayed trimmed through every later battle).
Unknown aspects block primary firing after detection
and enter `aspect_unknown` after 20 mismatching frames. `layout_learning.py` searches
at 5 Hz, reuses setup acceptance and self-checks, learns only from the profile's
own VS layout (own battle or spectate; the other kind is ignored), and immediately
activates an accepted layout while retaining the nickname from its confirmation
frame. The engine exposes geometry/learning/learned-layout events; monitor assigns
the shared trigger UUID. Layout learning is unavailable to legacy full-frame
profiles. Prediction aspect mismatch pauses prediction rather than killing the
monitor; legacy primary aspect-change behavior remains unchanged.
Runtime layout records include `layoutSource` and `calibratedAt`; the fifth layout
evicts the oldest learned layout, never a setup layout. Four setup layouts instead
produce `LAYOUT_LIMIT`.

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
≤0.30, and spectate setups accepted by the layout check. The prototype's measured 0.74
minimum is not a production threshold: `ORIENT_T=0.50` and setup self-check bounds
(VS ≥0.50, pre-VS <0.30) remain unchanged.

### Actual runtime replay (A2)

From `pc-build-v2`, using the portable Windows runtime interpreter:

```powershell
<runtime-python> python/tools/m9_replay.py runtime --manifest <external-manifest.json> --titlebar-image <external-titlebar.png> --titlebar-rect <x> <y> <width> <height> --out <external-output-directory>
```

Add `--prototype-jpeg92` and choose a separate external output directory to match
the prototype codec. The titlebar is read from the external image only; no input
frames, templates or owner paths are copied into the repository or `results.json`.
Alternatively, provide `runtime.titlebarImage` (relative to the manifest) and a
pixel `[x,y,width,height]` `runtime.titlebarRect` in the external manifest.
There is no owner-specific default image or crop.

This mode invokes the actual `TriggerEngine` with a validated v4 game-relative
payload and learning limited to four layouts. It reproduces the REPORT §4.4/§8.5
matrix: five own profiles, two same-aspect cross captures, eight resize/border
cases, two mid-stream frame resizes, two same-canvas game shrinks, and three
titlebar cases (22 positives); six ordinary-profile/spectate negatives; four
unknown-aspect recordings with learning disabled. It then feeds four complete
source/target recording pairs into one engine with learning enabled, requiring
the second recording to learn and fire on the same VS, and checks that three
cross-aspect spectate pairs are ignored without learning or failing. A profile
set up on `spectate_1` must fire once per VS on all three spectate recordings and
never on the five own-battle recordings, and sixteen `windowResize` cells (a
non-stretching title bar from the external titlebar crop) must fire once per VS
for fullscreen profiles in a window and small-window profiles resized. Six
`fullscreenLetterbox` cells replay MuMu F11 portrait (game stretched to 1864/1920
rows between black bars, after a menu whose side column stays still): with no
phantom band, both battles fire within 0.1 s on the windowed/spectate layout
(gap 1.030 is inside the match band) without learning; a battle within the
15-second cooldown is recorded as `cooldown`; own battles never fire the spectate
profile. Four `phantomBand` cells replay the 17.10.2026 stop on a profile set up
in F11: a dark menu peeled to an inset rect, with a still strip bordered where a
layout aspect places a left band (the setup aspect, or with the owner's stale
0.5488 phantom learned layout, its aspect), optionally a matchmaking screen,
then a battle, twice 16 s apart. Each VS fires once within 0.2 s on the setup
layout, no band remains and nothing is learned.

`boundary` mode sweeps game aspects at gaps 1.025–1.055 (squash as F11, taller,
and unscaled crop; letterbox bars) for an own-battle and a spectate profile with
learning on: three restarts per case, the game one row taller or shorter each
time, 16 s apart. Acceptance: every VS fires once, nothing learned up to 1.035,
at most one learning per case and only beyond 4.5%, never a learned→setup
return, and no geometry leaves `armed` within a frame size. It also measures
the VS badge height of all eight recordings and every sweep VS: own battles must
stay below and spectating above `layout_kind`'s 0.46.

Numeric output reports firing frames, per-VS counts/delays, false/blocked fires,
geometry states, learning codes/confidence, action sizes and process timings.
Score extrema omit transition frames, but every sampled frame reaches the engine.
An auxiliary zero-cooldown gate counts episodes from actual runtime match results;
the engine itself always uses the production 15-second cooldown.
Acceptance requires the complete matrix, exactly one fire per ordinary positive VS
within 0.2 seconds, no false fires or spectate fires, and standalone/new-frame-size
blocked aspects reaching `aspect_unknown` within 20 frames. Same-canvas aspect
changes require two consecutive periodic rechecks before restarting aggregation;
their bound is 45 frames (4.5 seconds). The learning evidence ring already samples
at 5 Hz during mismatch, and only a source-frame shape change resets it.
All four second recordings must learn and emit an action on that same VS. Paired
independent recordings use an explicitly reported simulated 16-second timestamp
gap without inserted frames, preserving the production 15-second cooldown;
target-relative delays and frame bounds exclude the gap. Missing cases, rejected
normal or spectate setups, missing learning events/actions, or cross-kind fires
fail the command with a nonzero exit. The 17 A1 distortion flags do not change this
runtime matrix.

### Predictions C3 detectors

Shape only: every comparison uses the doubled-angle edge-orientation field
(`geometry/shape_match.py`), never colour or brightness. Positions are interface
units of the M9 game rectangle, `U = min(height, width × 16/9)`.

Runtime wiring (game-relative profiles only): on an own-battle VS fire
(`kind == "battle"`) `TriggerEngine` runs `check_rank` on the trigger frame and
arms its `ResultReader`; any other fire disarms it. The `triggered` event carries
`rank`/`rankEvidence` (`"unknown"`/`null` for spectate and full-frame fires). On
ticks without a VS fire the armed reader reads the result screen;
`monitor_engine.FrameEvents` turns a report into one
`prediction_result {battleId, gap, outcome, evidence}`, where `battleId` is the
last own-battle `triggerId` and `gap` is set if the source was minimised since
that VS or the frames paused mid-read. When capture ends (stop, source closed,
failure) a read cut short is still reported (`FrameEvents.finish`), before
`stopped`. Prediction failures never stop the opponent monitor: a missing or
corrupt C3 asset turns that part off and writes
`PREDICTION_ASSET_UNAVAILABLE <error class>` to stderr.

- `geometry/rank_line.py` `check_rank(frame, gameRect, badge, RankTemplates.load())`
  reads the opponent and own rank lines and returns
  `{"rank", "rankEvidence": {"opponent", "own"}}`.
- `result_reader.py` `ResultReader`: armed from VS + 20 s to VS + 7 min. Idle ticks
  check only the small result-«vs» band; a burst reads the pill and six crown
  slots until the «vs» moves up (shift, also when it is already above its band),
  is missing for 0.6 s, the frames pause, or 3 s pass. Crown counts are reported
  only after a seen shift or the cap with the last read ≥ 1.0 s into the burst
  and the «vs» unread for at most one tick before it (a landing crown hides it
  longer); any other end leaves them `null`, so a cut-short count never becomes
  a draw. A detected PoL icon always counts as a seen pill.
- `prediction_values.py` holds every wire value, matching the server validation.
- `assets/result_screen_v1.json` and `assets/pol_rank_v1.json` hold quantised
  orientation fields only (no pixels, no names), generated once by
  `tools/make_c3_assets.py` from an external owner clip and the league/medal art;
  source SHA-256 values are recorded.
- `tools/m9_replay.py c3 --manifest <external.json> --out <external-dir>` (manifest
  format in `tools/c3_replay.py`) replays end-of-battle clips at 10 FPS in all six
  sampling phases (optionally also downscaled as smaller captures, judged on the
  full-size clip's timing) and the M9 VS recordings. Its wired group runs an own
  and a spectate VS recording, then each end clip, through `TriggerEngine` and
  `FrameEvents`; every event passes `encode_event`, and the image-free events are
  written to `wired-events.jsonl`; `tests/monitor-events-replay.test.ts` parses
  them with the TypeScript monitor contract when `CR_C3_EVENTS_JSONL` names that
  file. `CR_C3_REPLAY_MANIFEST` enables the matching Python `replay` test. The
  runtime and boundary replays also run through
  `FrameEvents` (every event validated); the runtime acceptance adds that VS-only
  recordings emit no `prediction_result`, only own-battle fires carry rank
  evidence, and Trainer Cheddar battles are never `pol`.

### Review fixes

Prepared capture retains eight exact full-resolution BGR samples, dropping alpha
and sharing the latest sample with the last frame when possible. A coarse-only
history was rejected because exact geometry/chrome matched only 7/16 recording
and sampling comparisons. The owner accepted the setup-session-only BGR history
budget: 47.46 MiB at 1080p, 189.84 MiB at 4K, 457.76 MiB at the 20-million-pixel
limit (eight samples; an unsampled latest frame adds one more). Stability subtracts
the temporal chrome from the single-frame probe before comparing game aspects,
so saved titlebars do not masquerade as changing game geometry.

Runtime rechecks probe the aggregated pre-chrome border, not the toolbar next to
the subtracted game rectangle. One missing periodic result leaves established
geometry intact; two consecutive missing rechecks clear it. Learning's five-Hz
history supplies both pre-VS confirmation and self-check evidence, and source-size
changes (not normalized one-pixel height drift) reset that history. Re-arming a
saved layout resets consecutive rejection/failure state; `no_game` alone never
starts learning. Aspect bounds use the exact detector constants, and retained
layout overlap is symmetric across learning, wire validation and persistence.

The command's 1 MiB budget includes the JSONL newline. Optional manual VS
classification geometry errors yield null VS fields without discarding structural
profiles; malformed protocol rectangles remain fatal.
