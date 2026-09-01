# Snipe Windows Client Workspace

This repository contains the Windows client and its test/release automation.
The related backend, admin, and canonical PWA repository is
`/home/art/dev/snipe-server` in WSL.

## Worktree safety

The original `C:\Dev\snipe-client` checkout may contain user changes and large
runtime artifacts. Never reset, clean, overwrite, or publish from a dirty
checkout. Use an existing clean worktree or create a task-specific worktree,
and review only the paths relevant to the task.

When a change affects API requests, authentication, WebSockets, manifests, or
update behavior, inspect the server contract and keep server/client commits in
separate pull requests.

## Development versus publication

Coding, tests, commits, pull requests, merges, and ordinary builds do not
authorize publication to users. `main` may contain unreleased changes, and the
package version may remain at the current public version during development.

- `Собери тестовую Windows-версию` permits
  `./publish-update.sh test [X.Y.Z]`, which must not deploy an update.
- Only `Опубликуй Windows X.Y.Z` permits
  `./publish-update.sh release X.Y.Z` and its `PUBLISH` confirmation.
- Requests such as implement, fix, test, build, prepare, merge, or continue do
  not authorize a release, version bump, signing, or upload.

Release only from a reviewed, clean, synchronized `main`. The release version
must be newer than the public manifest and must match reviewed package metadata.
The canonical server destination is
`/home/ubuntu/snipe-shared/data/updates/downloads/v2`. Always verify the public
manifest and installer after publication.

## Verification

Run checks affected by the change from `pc-build-v2`:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:shell`
- `npm run test:python`
- `npm run audit:release`
- `npm run build:app`

Use `npm run test:e2e:windows` or a real Windows launch/upgrade check when the
change affects desktop integration, installation, capture, or update behavior.
Do not claim those checks passed when the required Windows desktop is
unavailable.

## Secrets and generated files

Never commit or print GitHub tokens, signing keys, publisher config, `.env`
files, installers, portable runtimes, caches, logs, or generated build output.
Do not stage unrelated modifications from the original checkout.

## Context-efficient command output

Keep verbose command output out of the conversation.

- Redirect tests, builds, dependency installation, publisher output, large Git
  status/diffs, and workflow polling to a unique temporary log.
- Do not use `tee`.
- Report only pass/fail, exit code, concise test counts, artifact path, version,
  hash, and workflow URL when relevant.
- On failure, search the log and show only a small relevant error section.
- Inspect saved truncated output instead of rerunning a verbose command.
- Poll GitHub Actions quietly; report only meaningful state changes and the
  final conclusion.
- Delete successful temporary logs and never commit them.

Before a substantial operation, send one short progress update. Do not narrate
routine reads, searches, or every command.
