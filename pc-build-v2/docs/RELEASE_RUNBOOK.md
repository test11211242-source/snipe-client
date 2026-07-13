# CR Tools V2 Release Runbook

## Trust Model

CR Tools V2 is Windows-only and intentionally has no Authenticode certificate. Every fresh
installer or update can therefore trigger an unavoidable Windows SmartScreen "Unknown
publisher" warning. The Ed25519 manifest signature authenticates update metadata and the
installer SHA-512; it is not Authenticode and does not establish a Windows publisher.

The updater trusts only:

- manifest: `https://updates.artcsworld.xyz/downloads/v2/manifest.json`
- artifact: `https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_<x.y.z>.exe`
- public key: `resources/update-public-key.pem`
- SHA-256 SPKI fingerprint: `2a16488a2a16440e6c1ac19f82f9b262b7e9154d0851e3dbbac0be8d9b612d99`

The release private key must never enter the repository, an artifact, a command argument,
or logs. The temporary key currently outside the workspace at
`/tmp/opencode/cr-tools-v2-update-private.pem` must be moved into the GitHub Actions secret
`CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64`, then securely deleted from the temporary location
before the first release. Do not print the decoded secret while transferring it.

## Required Secrets

- `CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64`: base64 of the Ed25519 private PEM
- `SERVER_HOST`: deployment host
- `SERVER_USER`: deployment SSH user
- `SSH_PRIVATE_KEY`: deployment key
- `SERVER_KNOWN_HOSTS`: required pinned known-hosts line(s)

The workflow fails closed when `SERVER_KNOWN_HOSTS` is absent. Obtain and verify the host key
through an independent administrative channel before the first deployment.

## One-command Publisher

Run from `pc-build-v2`:

```bash
./publish-update.sh
```

The interactive command selects a version and either creates a test build or publishes a release.
Explicit forms are:

```bash
./publish-update.sh test 0.2.0
./publish-update.sh release 0.2.0
./publish-update.sh release 0.2.0 --critical
```

`test` runs local gates, commits and pushes only V2 release paths, dispatches the Windows workflow,
waits for the exact commit run, and downloads the installer into
`pc-build-v2/published/<version>/run-<id>/`. It never reads signing or deployment secrets and does
not publish an update. The hosted runner's GUI observation is diagnostic in this mode: a failure
does not block the installer artifact, but the publisher prints a mandatory manual Windows launch
warning.

`release` performs the same gates, requires the literal `PUBLISH` confirmation, signs and deploys
the manifest, verifies the remote hash and public HTTPS files, then downloads the released
installer locally. Unlike `test`, a packaged GUI smoke failure blocks release deployment.

The publisher never reads `pc-build/.env`. On the first interactive run it securely prompts for a
fine-grained token and can store it with mode `600`. Alternatively, authenticate with
`GH_TOKEN`/`GITHUB_TOKEN`, or create `~/.config/cr-tools-v2/publisher.env` containing only:

```text
GH_TOKEN=github_pat_...
```

Set the file mode to `600`. The token needs repository `Contents`, `Actions`, and `Workflows`
read/write access. `Workflows` is required specifically to commit files under `.github/workflows/`.
The publisher uses a temporary askpass process and GitHub API configuration, so the token is not
placed in the git remote URL or a command argument.

## Release

1. Confirm the requested version is unused strict `x.y.z` semver and update release notes.
2. Run the publisher in `release` mode, or manually dispatch `CR Tools V2 Windows release` with
   that version, the critical flag, and `deploy=true`.
3. The workflow uses Node 22 and `npm ci`, then gates lint, typecheck, Vitest, Python tests,
   npm audit, portable Python runtime validation, unpacked NSIS build, packaged Electron
   security smoke, unsigned installer build, manifest signing, and self-verification.
4. Confirm the artifact is exactly `CR_Tools_V2_Setup_<version>.exe` and retain the uploaded
   installer/runtime artifact plus the separate signed-manifest artifact.
5. Deployment uploads installer and manifest as `.new`, renames the installer first, and
   renames `manifest.json` last in `/home/ubuntu/snipe/data/updates/downloads/v2/`.

The workflow is manual and cannot deploy if an earlier test/build/signing step fails. The workflow
itself does not create a GitHub release or commit its package version change; the one-command
publisher commits the selected version before dispatch.

## Verification

After deployment, verify without logging the manifest signature:

1. Download the installer and manifest over HTTPS from their fixed public URLs.
2. Confirm filename and byte size match `artifact.fileName` and `artifact.size`.
3. Compute SHA-512 and compare its base64 value to `artifact.sha512`.
4. Verify the canonical payload's Ed25519 signature against the checked public key using the
   release tooling or updater tests.
5. Install on a clean Windows VM, acknowledge the expected unsigned-publisher warning, and
   run the auth-window Playwright smoke plus a manual update check.

## Rollback

Old versioned installers remain in the server directory. To roll back the advertised release,
restore a previously archived, valid manifest and its matching installer. Rename the restored
manifest last. Current clients reject equal or lower versions as updates, so rollback does not
silently downgrade installed clients; distribute the retained old installer manually if an
actual downgrade is required.

Do not overwrite or delete the previous installer until the replacement has passed clean-install
and updater checks.

## Key Rotation

Key rotation requires an application release containing the new public key before manifests
are signed only by the new private key. Because schema v1 has one signature, use this sequence:

1. Generate a new Ed25519 pair in an approved secret environment.
2. Replace the checked public key and document its new SPKI fingerprint.
3. Publish a transition application signed by the old manifest key.
4. Allow the supported client population to update.
5. Replace `CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64` with the new private PEM base64.
6. Publish subsequent manifests with the new key and securely destroy obsolete private copies.

If the old private key is compromised, stop publishing, remove `manifest.json` from service,
ship a clean installer through an independently authenticated channel, and do not claim that
clients with only the old embedded key can trust an in-band rotation.
