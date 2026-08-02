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
- SHA-256 SPKI fingerprint: `8be2a82e869112c3d67de63f0f60ee0d6beb057eb9b160d8effad92098a60b0d`

The release private key must never enter the repository, an artifact, a command argument,
or logs. It belongs in the GitHub Actions secret
`CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64`. During initial provisioning, the only local transfer
copy may be kept at `~/.config/cr-tools-v2/update-signing-private.pem` with mode `600`; it
must be securely deleted after the secret is registered. Do not print the decoded secret
while transferring it.

## Required Secrets

- `CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64`: base64 of the Ed25519 private PEM
- `SERVER_HOST`: deployment host
- `SERVER_USER`: deployment SSH user
- `SSH_PRIVATE_KEY`: base64-encoded deployment private key
- `SERVER_KNOWN_HOSTS`: required pinned known-hosts line(s)

The workflow fails closed when `SERVER_KNOWN_HOSTS` is absent. Obtain and verify the host key
through an independent administrative channel before the first deployment.

## GitHub Environment

The public repository uses a free Environment named `production`. GitHub creates it automatically
when the first deployment job references it. The five values above remain repository Actions
secrets; they do not need to be copied to Environment scope. The workflow and server promoter both
enforce `main`, while optional reviewers or wait timers can still be added later.

The Windows `build` job and Linux `promotion-tests` job do not reference production secrets. Only
the fresh `sign-deploy` job uses the `production` Environment. It checks out the exact dispatched
main commit, downloads the exact UUID-correlated Windows artifact, and runs the reviewed signing
and promotion scripts from that checkout.

## Static Route And Upgrade Fixture

`https://updates.artcsworld.xyz/downloads/v2/` is a static, read-only mapping to
`/home/ubuntu/snipe/data/updates/downloads/v2/`; it does not fall through to the application API.
The deployment script enforces directory mode `0755`, installer/manifest mode `0644`, and keeps
its lock, high-water record, and prepared manifest non-public.

The install-over-existing gate downloads the permanent pinned fixture from
`https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_0.1.18.exe`, then verifies the exact
159201176-byte size and SHA-512 in `Test-InstallerUpgrade.ps1`. GitHub is not permanent release
storage. Every workflow artifact has one-day retention and exists only to pass files between jobs
and return the just-built installer to the publisher.

## One-command Publisher

Run from `pc-build-v2`:

```bash
./publish-update.sh
```

The default interactive choice is `release`. The publisher checks the public manifest and either
reuses an unpublished package version or offers patch/minor/major. It runs all local gates, stages
only the V2 allowlist, commits, pushes `main` without placing the token in the remote URL, dispatches
the correlated workflow, waits, verifies the result, and downloads the installer locally.
Explicit forms are:

```bash
./publish-update.sh test 0.2.0
./publish-update.sh release 0.2.0
./publish-update.sh release 0.2.0 --critical
./publish-update.sh release --plan
```

The publisher enables first-release bootstrap automatically when the public manifest is absent.
The server permits it only when `manifest.json`, the durable `.high-water.v1.json`, and artifacts
other than the exact pinned `0.1.18` fixture are absent. Bootstrap cannot reset release history.

`test` performs the same selective validation, commit, and push but dispatches with deployment
disabled. It waits for the UUID-correlated run and downloads the installer into
`pc-build-v2/published/<version>/run-<id>/`. It never reads signing or deployment secrets and does
not publish an update. The hosted runner's GUI observation is diagnostic in this mode: a failure
does not block the installer artifact, but the publisher prints a mandatory manual Windows launch
warning. The same rule applies to the hosted install-over-existing check.

`release` verifies all required repository secret names, requires the literal `PUBLISH`
confirmation, makes the selective release commit, verifies the pushed SHA, signs and deploys,
verifies the remote hash and public HTTPS files with bounded retries, then downloads the released
installer locally. Unlike `test`, a packaged GUI or install-over-existing failure blocks release.

The publisher never reads `pc-build/.env`. On the first interactive run it securely prompts for a
fine-grained token and can store it with mode `600`. Alternatively, authenticate with
`GH_TOKEN`/`GITHUB_TOKEN`, or create `~/.config/cr-tools-v2/publisher.env` containing only:

```text
GH_TOKEN=github_pat_...
```

Set the file mode to `600`. The token needs `Contents` read/write, `Actions` read/write, and
`Secrets` read access. The GitHub API exposes only secret metadata and names during preflight,
never secret values. Git push uses a temporary askpass helper; the token is not placed in the git
remote URL or a command argument.

## Release

1. Change the V2 code, then run `./publish-update.sh`. Review the selected mode/version and type
   `PUBLISH`; the publisher handles package metadata, gates, selective commit, and push.
2. Alternatively, manually dispatch `CR Tools V2 Windows release` from
   `main` with that version, a unique lowercase UUID `correlation_id`, the critical flag,
   `deploy=true`, and normally `bootstrap=false`.
3. The workflow uses Node 22 and `npm ci`, then gates lint, typecheck, Vitest, Python tests,
   shell promotion tests, production npm dependencies plus an explicit dev-advisory allowlist,
   portable Python runtime validation, unpacked NSIS build, packaged Electron security smoke,
   unsigned installer build, and a silent NSIS install-over-existing check from the pinned 0.1.18
   artifact into a path containing spaces. The target installer receives no `/D` override, so the
   test verifies real existing-install discovery. The fresh production job then signs and
   self-verifies the schema v1 manifest.
4. Confirm the artifact is exactly `CR_Tools_V2_Setup_<version>.exe`. GitHub copies expire after
   one day; durable installer and manifest files remain on the existing update server.
5. Deployment uploads UUID-suffixed staging files. Under a server-side lock, it validates the
   complete strict schema-v1 shape, installer size/hash, complete manifest digest, current manifest,
   and durable high-water state. It first moves only the immutable installer into place. The
   workflow downloads that public URL and verifies SHA-512 before a second locked phase renames
   `manifest.json` and advances `.high-water.v1.json`. Same-version conflicting content and
   non-monotonic versions are refused; retrying identical content is a no-op.

Final public manifest verification runs in the separate `verify-production` job using the exact
installer and signed-manifest artifacts from the same workflow run. If only that job fails because
of a transient network/cache issue, use GitHub's **Re-run failed jobs** action; do not dispatch a
new same-version build. The promoter retains a commit-intent manifest until manifest and high-water
state agree, so an interrupted commit can complete safely on retry.

The workflow cannot deploy if an earlier test/build/signing step fails. Production is code-gated
to `main` and isolated in the free `production` Environment. The workflow verifies that production
input matches the package version committed by the publisher. The workflow itself does not create
a GitHub release or source commit.

## Verification

After deployment, verify without logging the manifest signature:

1. Download the installer and manifest over HTTPS from their fixed public URLs.
2. Confirm filename and byte size match `artifact.fileName` and `artifact.size`.
3. Compute SHA-512 and compare its base64 value to `artifact.sha512`.
4. Verify the canonical payload's Ed25519 signature against the checked public key using the
   release tooling or updater tests.
5. Install on a clean Windows VM, acknowledge the expected unsigned-publisher warning, and
   run the auth-window Playwright smoke plus a manual unauthenticated update check. Also verify an
   install over the currently supported production build on a real Windows desktop.

## Manifest Compatibility And Replay Limits

Release 0.1.18 strictly accepts only the current schema version 1 shape. Do not add fields to that
shape or publish a different schema for the first next release. New clients persist the highest
version and complete manifest digest only after the artifact has downloaded and passed its trusted
size and SHA-512 checks. Deployment independently enforces a durable monotonic server state. This
does not prevent an old signed manifest replay to a fresh client, a
client whose local state was reset, or a 0.1.18 client that has not yet updated.

Full signed expiry and global sequence protection require schema v2. Stage that migration by first
shipping, through an unchanged schema v1 manifest, a transition client that can accept both v1 and
v2. Continue publishing v1 until the supported client population has moved to the transition
client; only then may the server switch to a signed v2 expiry/sequence contract.

## Rollback

Old versioned installers remain in the server directory. The release workflow intentionally does
not support rollback because promotion is monotonic. For an emergency service rollback, an
administrator must follow a separately approved server procedure and understand that clients at a
higher installed version, or clients that persisted a higher trusted manifest, will reject the old
release. Distribute a retained installer manually if an actual downgrade is required.

If a signed release is bad, restore service by publishing known-good code as a strictly higher
version. Do not delete the high-water record, reuse a version with different content, or remove the
manifest to force bootstrap.

Do not overwrite or delete the previous installer until the replacement has passed clean-install
and updater checks.

## Key Rotation

The current client, manifest generator, and schema-v1 contract support exactly one public key and
cannot safely execute an in-band key rotation. Do not replace the checked public key or production
private-key secret independently. First implement and test a transition client that accepts both
old and new keys while its manifest is still signed by the old key; only after that client is
deployed and adopted may signing move to the new key. The generator must separately support the
old release-signing key and both embedded transition keys before this procedure is attempted.

If the old private key is compromised, stop publishing, remove `manifest.json` from service,
ship a clean installer through an independently authenticated channel, and do not claim that
clients with only the old embedded key can trust an in-band rotation.
