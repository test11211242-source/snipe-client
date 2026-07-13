# CR Tools V2 Parity and Beta Checklist

## Source Parity

| Capability                                   | V2 implementation                                                                                    | Automated gate                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Invite, registration, login, refresh, logout | Main-owned `AuthSession`, DPAPI refresh token, token-free renderers                                  | Vitest auth and API suites                   |
| Window and display selection                 | Opaque source registry, lazy preview, exact HWND and physical display mapping                        | Registry/provider contract tests             |
| Main OCR setup                               | Canonical Windows frame, staged region selection, trigger analysis, remote-first atomic local commit | Setup and Python analyzer tests              |
| Monitoring                                   | One persistent generation-fenced Python worker, 10 FPS trigger engine, fast/precise and PoL/GT       | Supervisor/process/protocol/trigger tests    |
| OCR results                                  | Bounded multipart client, honest result variants, ordered feed, administrator reprocessing           | OCR, WebSocket, and reprocessed-result tests |
| Desktop notifications                        | Main-only native notification for validated player results                                           | Notification service tests                   |
| Local widget                                 | Dedicated sandboxed window, deck navigation, image proxy, auto-open, position/lock/pin/opacity       | Widget and image service tests               |
| Twitch and predictions                       | System-browser OAuth, one-time server state, prediction server/local rollback, result trigger        | Streamer/prediction/setup tests              |
| Stream title and deck sharing                | Main-only server commands and strict success contracts                                               | Streamer adapter/service tests               |
| OBS widgets                                  | Adaptive settings, local mock previews, hidden capability URLs, enum-only clipboard copy             | Streamer UI and adapter tests                |
| Application settings                         | Reduced motion, Windows startup, diagnostics, widget settings                                        | Settings controller/UI tests                 |
| Updates                                      | Ed25519 manifest, bounded atomic download, repeated hash verification, locked Windows launch         | Manifest/updater/launcher tests              |
| Windows package                              | Unsigned NSIS x64, pinned Python runtime, integrity inventory, packaged security smoke               | Windows release workflow                     |

## Automated Commands

Run from `pc-build-v2`:

```text
npm ci
npm run lint
npm run typecheck
npm test
python -m pytest python/tests
npm audit --audit-level=high
npm run build:app
```

The release workflow additionally builds and validates the portable runtime, creates unpacked and
NSIS packages, runs packaged Electron security smoke, signs the update manifest, verifies the
remote artifact hash, publishes the manifest last, and checks the public HTTPS endpoints.

## Windows Beta Matrix

Each row must pass on a clean Windows 10 or Windows 11 x64 machine before changing the production
application identity or publishing V2.

| Scenario          | Required observations                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Clean install     | Unsigned publisher warning is shown honestly; install, launch, auth window, and uninstall complete                       |
| Auth and invite   | New device invite, register, login, refresh after restart, local logout, invalid/blocked HWID                            |
| Window capture    | Normal desktop app, emulator, dynamic title, minimized/restored, closed source, duplicate titles                         |
| Display capture   | Single display and mixed two/three-display layouts; exact source selected; ambiguous mapping fails closed                |
| Scaling           | 100%, 125%, and 150%; mixed scaling; negative monitor coordinates; region overlay remains aligned                        |
| Setup             | Trigger/normal/precise and prediction result areas; cancel, retry, partial remote failure, local disk failure            |
| Monitor lifecycle | Rapid start/stop/restart, logout while starting, source close, Python crash, stuck `taskkill`, app shutdown              |
| OCR               | Found, not found, recognition failure, service outage, 401 refresh, 150-second timeout, administrator reprocess          |
| Local widget      | Auto-open, manual open, pin, lock, opacity, compact mode, resize/move across monitors, logout race                       |
| Twitch            | Connect in system browser, callback polling, replay rejection, disconnect, expired token, server restart recovery        |
| Predictions       | Start with running/stopped monitor, battle start, win/loss result, stop, rollback, client restart with server bot active |
| Stream title      | Add/remove account, enable/pause, W/L reset, undo, restore original title, offline grace behavior                        |
| OBS               | Copy both URLs, add browser sources, all layouts/fonts/corners, preview warning, token rotation invalidates old URLs     |
| Runtime           | Bundled Python imports, one-shot capture, persistent capture, missing/tampered runtime fails closed                      |
| Updater           | Valid update, tampered manifest, tampered installer, interrupted download, redirect rejection, locked launch             |
| Rollback          | V1 remains runnable side by side; reinstall previous V2 artifact; user data isolation is preserved                       |

## Deployment Gates

1. Commit and push `pc-build-v2`, the release workflow, server security changes, and nginx static update location.
2. Revoke the plaintext GitHub PAT previously found in V1 `.env`.
3. Rotate the exposed Twitch client secret and move it to server secret management before restart.
4. Move `/tmp/opencode/cr-tools-v2-update-private.pem` into the protected
   `CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64` GitHub Actions secret, then securely delete the temporary file.
5. Configure a pinned `SERVER_KNOWN_HOSTS` secret; do not use live `ssh-keyscan` trust bootstrap.
6. Ensure the PostgreSQL role can create `streamer_oauth_states` on first upgraded server start.
7. Deploy and syntax-check `ops/nginx/snipe-artcsworld.conf`, create the V2 downloads directory, then reload nginx.
8. Restart the backend in a controlled window and verify invite denial remains HTTP 403 and OAuth state is one-time.
9. Run the Windows release workflow and verify both public `/downloads/v2/manifest.json` and installer URLs.
10. Complete the Windows beta matrix and record evidence before changing `com.snipe.client.v2` or replacing V1.

## Accepted Limitations

- Without Authenticode, Windows SmartScreen can show `Unknown publisher`. Ed25519 protects CR Tools
  update integrity but cannot remove that warning.
- Server logout/revocation for application refresh tokens does not exist; logout is local until a
  backward-compatible server endpoint is introduced.
- OBS links are bearer capability URLs. Token rotation is the revocation mechanism.
- Ambiguous native display mapping is rejected rather than guessed.
