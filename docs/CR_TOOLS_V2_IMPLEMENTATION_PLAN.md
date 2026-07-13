# CR Tools V2: Implementation Plan

## Status

- Product name: CR Tools
- Platform: Windows only
- Strategy: clean V2 implementation alongside the frozen V1
- V1 location: `/home/ubuntu/snipe/pc-build`
- V2 location: `/home/ubuntu/snipe/pc-build-v2`
- Settings migration: not required; users will sign in and configure capture again
- First public V2 release: all working V1 features
- Windows Authenticode certificate: unavailable by product decision
- Visual direction: dark operational workspace, existing purple/blue color identity, no neon
- M1 status: complete
- M2 status: complete in `pc-build-v2` (auth/network contracts, safeStorage,
  Windows identity, AuthSession, production HTTP/WebSocket, window routing, and tests)
- M3 status: implemented in `pc-build-v2` (opaque source registry, bounded previews and
  Python workers, staged per-user setup commit, legacy server projection, isolated setup
  renderer, exact fail-closed physical display/device mapping, and cross-platform tests).
  Windows hardware, mixed multi-monitor layouts, and 100/125/150% DPI validation remain
  release-gate work; ambiguous or unavailable native display metadata still fails closed.
- M4 status: implemented in `pc-build-v2` (strict renderer and private monitor contracts,
  atomic per-user modes, exact source re-resolution, one generation-fenced worker,
  versioned JSON-lines Python engine, bounded/cancellable OCR, serialized supervisor,
  lifecycle shutdown, narrow IPC, operational Home, and cross-platform tests). Windows
  hardware execution, source-close behavior against real applications, process-tree kill,
  and 100/125/150% DPI validation remain release-gate work.
- M5 status: implemented in `pc-build-v2` (dedicated sandboxed widget window/preload/CSP,
  URL-free result projection, generation-safe auto-open subscription, per-user atomic
  position/size/opacity/lock/pin settings, bounded allowlisted card asset proxy and LRU,
  accessible responsive renderer, real Settings controls, lifecycle cleanup, and
  cross-platform tests). Windows native move/resize, multi-monitor placement, focus
  behavior, and 100/125/150% DPI validation remain release-gate work.
- M6 status: implemented in `pc-build-v2` for the active streamer scope (main-owned Twitch
  system-browser OAuth and polling, prediction lifecycle and one-process result detection,
  atomic per-user preferences/result profiles, remote-first staged result setup, title/accounts,
  deck sharing, strict token-free OBS DTOs and enum-only URL copy, local mock previews, narrow
  IPC, role gating, and responsive tabbed workspace). Windows capture/OBS/Twitch end-to-end
  validation remains a release gate. Server OAuth state is now random, hashed, expiring, and
  atomically one-time; the previously exposed Twitch client secret must still be rotated and moved
  to secret management. OBS URLs remain server bearer capabilities.
- M7 status: implemented in `pc-build-v2` (one main-only custom updater, strict canonical
  Ed25519 manifest trust, fixed-origin bounded atomic downloads, repeated installer integrity
  verification, narrow sender-checked IPC, Settings controls, unsigned NSIS x64 packaging,
  pinned portable Python build/inventory, signed-manifest release tooling, manual atomic deploy
  workflow, and packaged Playwright security smoke). Windows execution of NSIS/runtime/E2E and
  physical hardware/DPI validation remain release gates; no Linux or Authenticode success is
  simulated.
- M8 status: source parity and security hardening are complete, including native notifications,
  administrator OCR reprocessing, real application settings, deny-by-default Electron permissions,
  bounded Windows process termination, runtime inventory verification, locked installer launch,
  one-time Twitch OAuth state, and static V2 update hosting configuration. Public cutover remains
  blocked on the manual Windows beta matrix and deployment actions recorded in
  `pc-build-v2/docs/PARITY_AND_BETA_CHECKLIST.md`.
- Server note: logout remains local because production has no revoke endpoint; the
  client keeps an explicit revocation seam without calling a nonexistent route

## Non-Negotiable Principles

1. V1 remains runnable and is used only as a behavioral specification.
2. V1 implementation code is not copied unless a small, reviewed algorithm is demonstrably correct.
3. The renderer is untrusted. It never receives access tokens, refresh tokens, filesystem access, generic IPC, generic store access, or installer paths.
4. Every IPC command is typed, runtime-validated, scoped to a specific window, and verified against the sender.
5. Main-process services have a single owner and are constructed once in the composition root.
6. Commands and queries are awaitable. An event bus may only carry one-way notifications.
7. Monitor, WebSocket, setup, updater, and application lifecycle are explicit state machines.
8. Every child process, socket, request, and asynchronous result is fenced by a generation or sequence identifier.
9. Security, type checking, tests, and Windows packaging are release gates, not optional cleanup.
10. Server changes remain backward compatible with V1 until V2 cutover.

## Product Scope

The first public V2 release includes:

- invite access flow;
- authentication and logout;
- production server connectivity;
- screen and window source selection;
- capture-region setup and validation;
- fast and precise search modes;
- PoL and GT deck modes;
- monitor start, stop, restart, and recovery;
- OCR result feed and session statistics;
- local opponent deck widget;
- Twitch connection;
- automatic predictions;
- automatic stream title;
- deck sharing;
- OBS streamer stats and opponent overlays;
- settings, diagnostics, update checks, download, and installation.

Placeholder pages from V1 are not carried over. Test-server switching and low-level trigger tuning move to an explicit developer/diagnostic mode.

## Target Technology

- Electron 43+
- TypeScript with strict compiler settings
- electron-vite and Vite
- React 19
- Zod for shared runtime contracts
- Vitest for unit and contract tests
- React Testing Library for renderer behavior
- Playwright Electron for Windows end-to-end tests
- Python pytest for capture and trigger algorithms
- electron-builder 26+
- Electron `safeStorage` backed by Windows DPAPI
- One versioned settings repository
- One update implementation

## Target Structure

```text
pc-build-v2/
  electron/
    main/
      application/
      domain/
      infrastructure/
      ipc/
      services/
      windows/
      bootstrap.ts
    preload/
      auth.ts
      main.ts
      setup.ts
      widget.ts
  renderer/
    src/
      app/
      components/
      features/
      pages/
      styles/
  shared/
    contracts/
    errors/
    models/
  python/
    capture/
    protocol/
    tests/
  tests/
    e2e/
    fixtures/
  resources/
  scripts/
```

## Target Main-Process Services

```text
ApplicationController
WindowCoordinator
AuthSession
ApiClient
WebSocketSession
MonitorSupervisor
PythonWorkerService
SetupService
UpdateService
SettingsRepository
StructuredLogger
```

### ApplicationController

Owns the application lifecycle:

```text
BOOTING -> AUTHENTICATING -> READY -> SHUTTING_DOWN -> STOPPED
                              |-> RECOVERING
```

It acquires the single-instance lock, coordinates startup and shutdown, and is the only component allowed to decide whether closing a window quits the application.

### WindowCoordinator

Owns one registry of all Electron windows. Each window has a dedicated preload and capability set. Navigation and popup creation are denied by default. OAuth uses an allowlisted external-browser flow or a dedicated window without privileged preload.

### AuthSession

Refresh tokens remain in the main process and are encrypted with `safeStorage`. Authentication uses a protected identity endpoint, not a public health check. Refresh is single-flight, logout revokes and clears all state, and renderers receive only an `AuthView`.

### ApiClient

All application HTTP traffic originates in the main process. The client has one normalized result/error model, request cancellation, safe retry rules, idempotency support where needed, and redacted structured logs.

### WebSocketSession

```text
DISCONNECTED -> CONNECTING -> TRANSPORT_OPEN -> AUTHENTICATING -> READY
       ^                                                        |
       |--------------------- BACKOFF <--------------------------|
```

Every socket callback captures its generation. The service has transport and auth timeouts, ping/pong heartbeat, exponential backoff with jitter, and clean coordination with AuthSession.

### MonitorSupervisor

```text
STOPPED -> PREFLIGHT -> STARTING -> READY -> STOPPING -> STOPPED
                            |         |
                            v         v
                           FAILED -> BACKOFF
```

Commands are serialized. Each process session owns its child, generation ID, protocol sequence, temporary files, and readiness waiter. Stop waits for graceful exit, then kills the Windows process tree after a deadline.

### SetupService

```text
CREATED -> CAPTURING -> SELECTING -> ANALYZING -> REVIEW -> SAVING -> COMMITTED
```

Capture target and regions are staged and committed atomically. A failed or cancelled setup never changes the active runtime configuration.

## IPC Boundary

Separate preload APIs are generated for auth, main, setup, and widget windows. There is no generic `invoke` and no generic store API.

Each handler performs:

1. sender WebContents/window verification;
2. source URL verification;
3. Zod payload validation;
4. use-case invocation;
5. typed DTO serialization;
6. structured, redacted error mapping.

## Python Protocol

All messages use a versioned JSON-lines envelope:

```json
{
  "protocolVersion": 1,
  "sessionId": "uuid",
  "sequence": 42,
  "type": "action",
  "payload": {}
}
```

Required protections:

- bitwise 64-bit Hamming distance;
- bounded image dimensions and byte size;
- bounded stdout and stderr;
- hard process timeout;
- request semaphore;
- request/session identifiers;
- stale-result rejection;
- deterministic cleanup in `finally`;
- debug output disabled by default;
- golden-image tests for ORB/NCC behavior.

## Information Architecture

```text
Home
Capture
Streamer
Settings
```

### Home

- readiness and health summary;
- primary monitor start/stop control;
- actionable configuration issues;
- recent results feed;
- compact session statistics.

### Capture

- source selection;
- setup wizard;
- region review;
- configuration test;
- collapsed diagnostics.

### Streamer

- predictions;
- stream title;
- Twitch and deck sharing;
- OBS widget configuration and preview.

### Settings

- application behavior;
- local widget behavior;
- updates;
- diagnostics;
- version and product information.

## Visual System

```text
Background       #080913
Surface          #111322
Raised surface   #171A2B
Border           rgba(255,255,255,.08)
Primary          #8B5CF6
Information      #60A5FA
Text             #F0F0F5
Muted text       #9A9DB2
Success          #34D399
Warning          #F59E0B
Danger           #F87171
```

Rules:

- no aurora, particles, gradient text, permanent glow, or neumorphism;
- SVG icon system instead of emoji;
- radii of 6, 8, and 12 pixels;
- feedback motion of 120-180 ms only;
- no layout movement on hover;
- `prefers-reduced-motion` support;
- visible keyboard focus and complete keyboard navigation;
- accessible dialogs, alerts, toasts, and form errors;
- verified at Windows scaling levels 100%, 125%, and 150%.

## Update Security Without Authenticode

The product will not purchase a Windows code-signing certificate. Windows SmartScreen publisher warnings therefore cannot be eliminated.

Update authenticity will still be protected independently:

1. Generate an Ed25519 release key pair.
2. Embed only the public key in the application.
3. Store the private key only in the release secret store.
4. Sign a canonical release manifest.
5. Verify the manifest signature in the main process.
6. Restrict downloads to an exact HTTPS origin and reject cross-origin redirects.
7. Verify installer version, name, size bounds, and SHA-512.
8. Use an atomic partial-file download and support cancellation.
9. Never accept an installer path from a renderer.
10. Fail closed on every validation or confirmation error.

## Delivery Milestones

### M0: Security and Behavioral Baseline

- revoke the plaintext GitHub PAT found in V1 `.env`;
- document all V1 user flows and server endpoints;
- create a feature-parity matrix;
- capture protocol and OCR fixtures;
- freeze V1 behavior except emergency security fixes.

### M1: V2 Foundation

- create isolated package and build system;
- configure strict TypeScript, linting, formatting, tests, and CI commands;
- implement shared contracts and errors;
- create the composition root, logger, settings repository, and single-instance lifecycle;
- establish per-window preloads and IPC verification.

### M2: Auth and Network Core

- implement safe token storage and AuthSession;
- implement ApiClient and protected identity validation;
- implement WebSocketSession state machine;
- add contract, refresh-race, outage, and reconnect tests.

### M3: Capture and Setup

- implement source enumeration and capability checks;
- implement staged SetupSession;
- implement bounded PythonWorkerService;
- build the new capture wizard;
- test window/screen capture and Windows DPI scenarios.

### M4: Monitor and Results

- implement MonitorSupervisor;
- implement the versioned Python protocol;
- fix and test trigger algorithms;
- implement the result projection and Home screen;
- test concurrent start/stop/restart and stale process events.

Status: complete in source and cross-platform automation. Windows backend and packaged-runtime
validation remain release gates; no Linux capture success path is provided.

### M5: Local Widget

- implement ordered result projection and image cancellation;
- implement window position, size, opacity, lock, pin, and auto-open settings;
- add accessible controls and documented shortcuts.

Status: complete in source and cross-platform automation. The widget uses native Windows
window movement rather than a custom drag surface; pin, lock, compact mode, opacity, deck
selection, hide, and Settings-page open controls are labeled and keyboard accessible.
Windows native-window, multi-monitor, focus, and DPI validation remain release gates.

### M6: Streamer Features

- move all streamer HTTP operations to the main process;
- migrate predictions, Twitch, stream title, deck sharing, and OBS widgets;
- add cancellable polling and stale-response protection;
- retain backward-compatible server behavior for V1.

Status: complete in source and cross-platform automation for the active scope. V1 placeholders
(alerts, Discord, generic OBS, and smart predictions) are deliberately excluded. The server's two
result-region writes are not transactional; V2 reports partial remote completion and does not
activate local state until both writes succeed.

### M7: Updater and Packaging

- implement signed-manifest verification;
- pin and validate portable Python dependencies;
- build the Windows installer;
- add Windows smoke and end-to-end tests;
- verify artifact identity and hashes before publication.

Status: complete in source and cross-platform automation. Product releases remain unsigned by
Authenticode and therefore show unavoidable SmartScreen publisher warnings. The Windows-only
runtime, NSIS, and packaged Playwright gates must execute successfully in GitHub Actions before
publication.

### M8: Parity, Beta, and Cutover

- run the same scenario matrix against V1 and V2;
- complete a clean-install beta;
- verify rollback to V1;
- switch V2 to the production app ID and update channel;
- publish only when every release gate passes.

## Release Gates

- no raw token is observable in any renderer;
- no generic IPC or generic store mutation exists;
- no untrusted value reaches `innerHTML`;
- exactly one updater, settings repository, auth session, API client, and window registry exist;
- monitor concurrency and stale-generation tests pass;
- every Python child has timeout, size limits, and deterministic cleanup;
- all working V1 functionality is represented in the parity matrix and passes;
- no placeholder navigation is visible;
- keyboard and scaling checks pass;
- update manifest and installer integrity verification pass;
- Windows build and Electron smoke tests pass.

## Required Manual Action

The GitHub personal access token currently stored in plaintext in V1 must be revoked and replaced before another public release. The replacement must not be stored in the workspace or passed in process arguments.
