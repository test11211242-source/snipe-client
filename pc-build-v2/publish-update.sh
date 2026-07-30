#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
WORKFLOW_FILE="pc-build-v2-release.yml"
PUBLISHER_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/cr-tools-v2/publisher.env"
PUBLISH_ROOT="$SCRIPT_DIR/published"
TMP_DIR="$(mktemp -d)"
MODE=""
VERSION=""
CRITICAL=false
BOOTSTRAP=false
ASSUME_YES=false
PLAN_ONLY=false
CORRELATION_ID=''

cleanup() {
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

usage() {
  cat <<'EOF'
Usage:
  ./publish-update.sh
  ./publish-update.sh test [x.y.z] [--yes]
  ./publish-update.sh release [x.y.z] [--critical] [--bootstrap] [--yes]
  ./publish-update.sh release --plan

Modes:
  release  Validate, commit, push, build, sign, deploy, and verify an update.
  test     Validate, commit, push, and download a Windows installer without deployment.

Without a version, the publisher reuses an unpublished package version or offers
patch/minor/major after the current version. First-release bootstrap is automatic.

Authentication:
  Set GH_TOKEN/GITHUB_TOKEN, or create ~/.config/cr-tools-v2/publisher.env
  with GH_TOKEN=... and chmod 600. Required repository permissions are
  Contents read/write, Actions read/write, and Secrets read. The old pc-build/.env is never read.
EOF
}

while (($# > 0)); do
  case "$1" in
    test | release)
      [[ -z "$MODE" ]] || die 'Build mode was provided more than once.'
      MODE="$1"
      ;;
    --critical)
      CRITICAL=true
      ;;
    --bootstrap)
      BOOTSTRAP=true
      ;;
    --yes | -y)
      ASSUME_YES=true
      ;;
    --plan)
      PLAN_ONLY=true
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$VERSION" && "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
        VERSION="$1"
      else
        die "Unknown argument: $1"
      fi
      ;;
  esac
  shift
done

if [[ -z "$MODE" ]]; then
  [[ -t 0 ]] || die 'Specify test or release in non-interactive mode.'
  printf '\nSelect publish mode:\n'
  printf '  [1] release Validate, commit, build, and publish\n'
  printf '  [2] test    Validate, commit, and build without publishing\n'
  read -r -p 'Choice [1]: ' mode_choice
  case "${mode_choice:-1}" in
    1) MODE=release ;;
    2) MODE=test ;;
    *) die 'Invalid build mode.' ;;
  esac
fi

[[ "$MODE" == release || "$CRITICAL" == false ]] || die '--critical requires release mode.'
[[ "$MODE" == release || "$BOOTSTRAP" == false ]] || die '--bootstrap requires release mode.'

require_command git
require_command node
require_command npm
require_command python3
require_command curl
require_command unzip
require_command sha512sum
require_command stat
require_command install
CORRELATION_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"

cd "$SCRIPT_DIR"
CURRENT_VERSION="$(node -p "require('./package.json').version")"
[[ "$CURRENT_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die "package.json contains an invalid version: $CURRENT_VERSION"

semver_compare() {
  node -e '
  const [left, right] = process.argv.slice(1).map((value) => value.split(".").map(BigInt));
  let result = 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) { result = left[i] > right[i] ? 1 : -1; break; }
  }
  process.stdout.write(String(result));
  ' "$1" "$2"
}

published_manifest="$TMP_DIR/published-manifest.json"
published_status="$(curl --silent --show-error --proto '=https' --tlsv1.2 \
  --output "$published_manifest" --write-out '%{http_code}' \
  'https://updates.artcsworld.xyz/downloads/v2/manifest.json')" ||
  die 'The production update manifest could not be checked.'
PUBLISHED_VERSION=''
if [[ "$published_status" == 200 ]]; then
  PUBLISHED_VERSION="$(node -e '
    const fs = require("fs");
    try {
      const version = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
      if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) process.exit(2);
      process.stdout.write(version);
    } catch { process.exit(2); }
  ' "$published_manifest")" || die 'Published manifest could not be parsed.'
elif [[ "$published_status" == 404 ]]; then
  if [[ "$MODE" == release ]]; then BOOTSTRAP=true; fi
else
  die "Production manifest preflight returned HTTP $published_status."
fi

if [[ -z "$VERSION" ]]; then
  if [[ -z "$PUBLISHED_VERSION" || "$(semver_compare "$CURRENT_VERSION" "$PUBLISHED_VERSION")" -gt 0 ]]; then
    VERSION="$CURRENT_VERSION"
  elif [[ "$(semver_compare "$CURRENT_VERSION" "$PUBLISHED_VERSION")" -lt 0 ]]; then
    die "package.json $CURRENT_VERSION is older than published $PUBLISHED_VERSION."
  else
    IFS='.' read -r major minor patch <<<"$CURRENT_VERSION"
    patch_version="$major.$minor.$((patch + 1))"
    minor_version="$major.$((minor + 1)).0"
    major_version="$((major + 1)).0.0"
    if [[ -t 0 && "$ASSUME_YES" == false ]]; then
      printf '\nPublished version: %s\n' "$PUBLISHED_VERSION"
      printf '  [1] patch %s\n' "$patch_version"
      printf '  [2] minor %s\n' "$minor_version"
      printf '  [3] major %s\n' "$major_version"
      read -r -p 'Choice [1]: ' version_choice
      case "${version_choice:-1}" in
        1) VERSION="$patch_version" ;;
        2) VERSION="$minor_version" ;;
        3) VERSION="$major_version" ;;
        *) die 'Invalid version choice.' ;;
      esac
    else
      VERSION="$patch_version"
    fi
  fi
fi

[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die "Version must use strict x.y.z semver: $VERSION"
((${#VERSION} <= 32)) || die 'Version is too long.'
[[ "$(semver_compare "$VERSION" "$CURRENT_VERSION")" -ge 0 ]] ||
  die 'Build version cannot be lower than package.json.'
if [[ "$MODE" == release && -n "$PUBLISHED_VERSION" ]]; then
  [[ "$(semver_compare "$VERSION" "$PUBLISHED_VERSION")" -gt 0 ]] ||
    die "Release $VERSION must be newer than published $PUBLISHED_VERSION."
fi

if [[ "$PLAN_ONLY" == true ]]; then
  printf 'Mode: %s\n' "$MODE"
  printf 'Package version: %s\n' "$CURRENT_VERSION"
  printf 'Published version: %s\n' "${PUBLISHED_VERSION:-none}"
  printf 'Selected version: %s\n' "$VERSION"
  printf 'Bootstrap: %s\n' "$BOOTSTRAP"
  exit 0
fi

if [[ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" && -f "$PUBLISHER_CONFIG" ]]; then
  config_mode="$(stat -c '%a' "$PUBLISHER_CONFIG")"
  [[ "$config_mode" == 600 || "$config_mode" == 400 ]] ||
    die "$PUBLISHER_CONFIG must have mode 600 or 400."
  while IFS= read -r config_line || [[ -n "$config_line" ]]; do
    case "$config_line" in
      '' | \#*) ;;
      GH_TOKEN=*) GH_TOKEN="${config_line#GH_TOKEN=}" ;;
      GITHUB_TOKEN=*) GITHUB_TOKEN="${config_line#GITHUB_TOKEN=}" ;;
      *) die "$PUBLISHER_CONFIG may contain only GH_TOKEN or GITHUB_TOKEN." ;;
    esac
  done <"$PUBLISHER_CONFIG"
fi
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$TOKEN" && -t 0 ]]; then
  printf '\nA fine-grained GitHub token is required once.\n'
  printf 'Required repository permissions: Contents read/write, Actions read/write, Secrets read.\n'
  read -r -s -p 'GitHub token: ' TOKEN
  printf '\n'
  [[ -n "$TOKEN" ]] || die 'GitHub token was not provided.'
  [[ "$TOKEN" =~ ^[A-Za-z0-9_]+$ ]] || die 'GitHub token contains unsupported characters.'
  read -r -p "Save it to $PUBLISHER_CONFIG with mode 600? [Y/n]: " save_token
  if [[ "${save_token:-Y}" =~ ^[Yy]$ ]]; then
    config_dir="$(dirname "$PUBLISHER_CONFIG")"
    mkdir -p -- "$config_dir"
    chmod 700 "$config_dir"
    umask 077
    printf 'GH_TOKEN=%s\n' "$TOKEN" >"$PUBLISHER_CONFIG"
    chmod 600 "$PUBLISHER_CONFIG"
  fi
fi
[[ -n "$TOKEN" ]] || die 'GitHub token is missing. Set GH_TOKEN or GITHUB_TOKEN.'
[[ "$TOKEN" =~ ^[A-Za-z0-9_]+$ ]] || die 'GitHub token contains unsupported characters.'

REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin)"
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
  REPOSITORY="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
else
  die "origin is not a supported GitHub remote: $REMOTE_URL"
fi
BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
[[ -n "$BRANCH" ]] || die 'Detached HEAD is not supported.'
[[ "$BRANCH" == main ]] || die "Publisher must run from main, current branch: $BRANCH"

RELEASE_PATHS=(
  'pc-build-v2/electron'
  'pc-build-v2/renderer'
  'pc-build-v2/shared'
  'pc-build-v2/python'
  'pc-build-v2/tests'
  'pc-build-v2/scripts'
  'pc-build-v2/resources'
  'pc-build-v2/docs'
  'pc-build-v2/.gitattributes'
  'pc-build-v2/.gitignore'
  'pc-build-v2/.prettierignore'
  'pc-build-v2/.prettierrc.json'
  'pc-build-v2/electron-builder.yml'
  'pc-build-v2/electron.vite.config.ts'
  'pc-build-v2/eslint.config.js'
  'pc-build-v2/package-lock.json'
  'pc-build-v2/package.json'
  'pc-build-v2/playwright.config.ts'
  'pc-build-v2/publish-update.sh'
  'pc-build-v2/README.md'
  'pc-build-v2/tsconfig.json'
  'pc-build-v2/vitest.config.ts'
  '.github/workflows/pc-build-v2-release.yml'
  'docs/CR_TOOLS_V2_IMPLEMENTATION_PLAN.md'
  'ops/nginx/snipe-artcsworld.conf'
)

git -C "$REPO_ROOT" diff --cached --quiet ||
  die 'The git index already contains staged changes. Commit or unstage them first.'
mapfile -d '' dirty_release_paths < <(
  git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all -z -- "${RELEASE_PATHS[@]}"
)
if ((${#dirty_release_paths[@]} == 0)) && [[ "$VERSION" != "$CURRENT_VERSION" ]]; then
  die 'There are no V2 changes to commit for a new release version.'
fi
if ((${#dirty_release_paths[@]} > 0)); then
  printf '\nV2 changes that will be validated and committed:\n'
  printf '  %s\n' "${dirty_release_paths[@]}"
fi

if [[ "$MODE" == release && "$ASSUME_YES" == false ]]; then
  printf '\nWARNING: this will validate, commit, push, and publish CR Tools V2 %s.\n' "$VERSION"
  read -r -p 'Type PUBLISH to continue: ' confirmation
  [[ "$confirmation" == PUBLISH ]] || die 'Production publication was cancelled.'
elif [[ "$MODE" == test && "$ASSUME_YES" == false ]]; then
  read -r -p "Build test version $VERSION from the reviewed main commit? [Y/n]: " confirmation
  [[ "${confirmation:-Y}" =~ ^[Yy]$ ]] || die 'Test build was cancelled.'
fi

github_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local quiet="${4:-false}"
  local response_file="$TMP_DIR/api-response-$RANDOM.json"
  local status
  local -a arguments=(
    --request "$method"
    --url "https://api.github.com$path"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    arguments+=(--data "$body")
  fi
  status="$({
    printf 'silent\n'
    printf 'show-error\n'
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
    printf 'header = "Content-Type: application/json"\n'
  } | curl --config - "${arguments[@]}")"
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    if [[ "$quiet" != true ]]; then
      printf 'GitHub API request failed with HTTP %s:\n' "$status" >&2
      node -e '
        const fs = require("fs");
        try {
          const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          console.error(value.message || "Unknown GitHub API error");
        } catch { console.error("Unreadable GitHub API error"); }
      ' "$response_file"
    fi
    return 1
  fi
  cat "$response_file"
}

github_download() {
  local path="$1"
  local output="$2"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'location\n'
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  } | curl --config - --url "https://api.github.com$path" --output "$output"
}

push_main() {
  local askpass="$TMP_DIR/git-askpass.sh"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$1" in' \
    '  *Username*) printf "x-access-token\\n" ;;' \
    '  *Password*) printf "%s\\n" "$CR_TOOLS_GITHUB_TOKEN" ;;' \
    '  *) exit 1 ;;' \
    'esac' >"$askpass"
  chmod 700 "$askpass"
  CR_TOOLS_GITHUB_TOKEN="$TOKEN" \
    GIT_ASKPASS="$askpass" \
    GIT_TERMINAL_PROMPT=0 \
    git -C "$REPO_ROOT" -c credential.helper= push origin HEAD:main
}

info 'Validating GitHub repository access'
repository_json="$(github_api GET "/repos/$REPOSITORY")"
can_read="$(printf '%s' "$repository_json" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const repository = JSON.parse(input);
    process.stdout.write(repository.permissions?.pull === true && repository.permissions?.push === true ? "true" : "false");
  });
')"
[[ "$can_read" == true ]] || die 'GitHub token does not have Contents read/write access to this repository.'

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
remote_commit_json="$(github_api GET "/repos/$REPOSITORY/commits/main")"
remote_main_sha="$(printf '%s' "$remote_commit_json" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input).sha || ""));
')"
NEEDS_PUSH=false
if [[ "$HEAD_SHA" != "$remote_main_sha" ]]; then
  if git -C "$REPO_ROOT" merge-base --is-ancestor "$remote_main_sha" "$HEAD_SHA" 2>/dev/null; then
    NEEDS_PUSH=true
  else
    die 'Local main is behind or diverged from origin main. Synchronize it before publishing.'
  fi
fi

if [[ "$MODE" == release ]]; then
  info 'Preflighting repository release secrets'
  repository_secrets="$(github_api GET "/repos/$REPOSITORY/actions/secrets?per_page=100")"
  missing_secrets="$(printf '%s' "$repository_secrets" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const present = new Set((JSON.parse(input).secrets || []).map((secret) => secret.name));
      const required = [
        "CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64",
        "SERVER_HOST",
        "SERVER_USER",
        "SSH_PRIVATE_KEY",
        "SERVER_KNOWN_HOSTS",
      ];
      process.stdout.write(required.filter((name) => !present.has(name)).join(", "));
    });
  ')"
  [[ -z "$missing_secrets" ]] || die "Repository is missing required release secrets: $missing_secrets"
  [[ -z "$PUBLISHED_VERSION" || "$BOOTSTRAP" == false ]] ||
    die 'Bootstrap was requested but production already has a manifest.'
fi

info "Preparing CR Tools V2 $VERSION ($MODE)"
info 'Installing deterministic Node dependencies'
npm ci
if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
  info "Updating package metadata to $VERSION"
  npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
fi

PYTHON_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/cr-tools-v2/publisher-venv"
if [[ ! -x "$PYTHON_CACHE/bin/python" ]]; then
  info 'Creating cached Python test environment'
  mkdir -p -- "$(dirname "$PYTHON_CACHE")"
  python3 -m venv "$PYTHON_CACHE"
fi
"$PYTHON_CACHE/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-compile \
  --only-binary=:all: \
  -r python/requirements-linux-test.txt

info 'Running local release gates'
npm run lint
npm run typecheck
npm run release:verify-inputs
npm test
npm run test:shell
(
  cd python
  "$PYTHON_CACHE/bin/python" -m pytest tests
)
npm run audit:release
npm run build:app

info 'Creating the reviewed V2 release commit'
git -C "$REPO_ROOT" add -A -- "${RELEASE_PATHS[@]}"
git -C "$REPO_ROOT" diff --cached --check
if ! git -C "$REPO_ROOT" diff --cached --quiet; then
  git -C "$REPO_ROOT" diff --cached --stat
  git -C "$REPO_ROOT" commit -m "release: prepare CR Tools V2 $VERSION"
  NEEDS_PUSH=true
else
  info 'No new V2 changes to commit; reusing the pending release commit'
fi

mapfile -d '' remaining_release_changes < <(
  git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all -z -- "${RELEASE_PATHS[@]}"
)
((${#remaining_release_changes[@]} == 0)) ||
  die 'V2 release paths changed during commit; review them before publishing.'

if [[ "$NEEDS_PUSH" == true ]]; then
  info 'Pushing the release commit to origin main'
  push_main
fi
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
remote_matches=false
for push_check in {1..30}; do
  remote_commit_json="$(github_api GET "/repos/$REPOSITORY/commits/main")"
  remote_main_sha="$(printf '%s' "$remote_commit_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).sha || ""));
  ')"
  if [[ "$remote_main_sha" == "$HEAD_SHA" ]]; then
    remote_matches=true
    break
  fi
  sleep 2
done
[[ "$remote_matches" == true ]] || die 'origin main did not reach the release commit.'

runs_path="/repos/$REPOSITORY/actions/workflows/$WORKFLOW_FILE/runs?event=workflow_dispatch&branch=$BRANCH&per_page=100"
workflow_registered=false
for registration_attempt in {1..30}; do
  if github_api GET "$runs_path" '' true >/dev/null; then
    workflow_registered=true
    break
  fi
  printf '\rWaiting for GitHub to register the workflow (%d/30)' "$registration_attempt"
  sleep 2
done
if [[ "$workflow_registered" != true ]]; then
  printf '\n'
  github_api GET "$runs_path" >/dev/null
  die 'GitHub did not register the workflow within 60 seconds.'
fi
if ((registration_attempt > 1)); then
  printf '\n'
fi

dispatch_body="$(node -e '
  const [ref, version, correlationId, deploy, critical, bootstrap] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    ref,
    inputs: {
      version,
      correlation_id: correlationId,
      deploy: deploy === "true",
      critical: critical === "true",
      bootstrap: bootstrap === "true",
    },
  }));
' "$BRANCH" "$VERSION" "$CORRELATION_ID" "$([[ "$MODE" == release ]] && printf true || printf false)" "$CRITICAL" "$BOOTSTRAP")"

info 'Dispatching the Windows workflow'
github_api POST "/repos/$REPOSITORY/actions/workflows/$WORKFLOW_FILE/dispatches" "$dispatch_body" >/dev/null

RUN_TITLE="CR Tools V2 $VERSION [$CORRELATION_ID]"
RUN_ID=""
for _ in {1..30}; do
  sleep 2
  runs="$(github_api GET "$runs_path")"
  RUN_ID="$(printf '%s' "$runs" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const [sha, title] = process.argv.slice(1);
      const runs = JSON.parse(input).workflow_runs || [];
      const match = runs.find((run) => run.head_sha === sha && run.display_title === title);
      if (match) process.stdout.write(String(match.id));
    });
  ' "$HEAD_SHA" "$RUN_TITLE")"
  [[ -z "$RUN_ID" ]] || break
done
[[ -n "$RUN_ID" ]] || die 'The dispatched workflow run could not be identified.'

RUN_URL="https://github.com/$REPOSITORY/actions/runs/$RUN_ID"
info "Waiting for Windows build $RUN_ID"
printf 'Run: %s\n' "$RUN_URL"

WORKFLOW_WARNING=false
for attempt in {1..360}; do
  run_json="$(github_api GET "/repos/$REPOSITORY/actions/runs/$RUN_ID")"
  run_state="$(printf '%s' "$run_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const run = JSON.parse(input);
      process.stdout.write(`${run.status || "unknown"} ${run.conclusion || "pending"}`);
    });
  ')"
  IFS=' ' read -r run_status run_conclusion <<<"$run_state"
  printf '\rStatus: %-12s conclusion: %-12s (%d/360)' "$run_status" "$run_conclusion" "$attempt"
  if [[ "$run_status" == completed ]]; then
    printf '\n'
    if [[ "$run_conclusion" != success ]]; then
      if [[ "$MODE" == test ]]; then
        WORKFLOW_WARNING=true
        printf 'WARNING: The test workflow reported failure. Checking whether a complete installer artifact was uploaded.\n'
      else
        die "Windows workflow failed: $RUN_URL"
      fi
    fi
    break
  fi
  ((attempt < 360)) || die "Timed out waiting for Windows workflow: $RUN_URL"
  sleep 10
done

SMOKE_WARNING=false
ARTIFACT_ID=""
for artifact_attempt in {1..30}; do
  artifacts_json="$(github_api GET "/repos/$REPOSITORY/actions/runs/$RUN_ID/artifacts?per_page=100")"
  ARTIFACT_ID="$(printf '%s' "$artifacts_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const artifacts = JSON.parse(input).artifacts || [];
      const match = artifacts.find((artifact) => artifact.name === name && !artifact.expired);
      if (match) process.stdout.write(String(match.id));
    });
  ' "cr-tools-v2-$VERSION-$CORRELATION_ID")"
  [[ -z "$ARTIFACT_ID" ]] || break
  printf '\rWaiting for the Windows artifact (%d/30)' "$artifact_attempt"
  sleep 2
done
if ((artifact_attempt > 1)); then
  printf '\n'
fi
[[ -n "$ARTIFACT_ID" ]] || die 'Windows installer artifact was not found.'
if [[ "$MODE" == test ]]; then
  smoke_artifact_present="$(printf '%s' "$artifacts_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const artifacts = JSON.parse(input).artifacts || [];
      process.stdout.write(artifacts.some((artifact) => artifact.name === name) ? "true" : "false");
    });
  ' "cr-tools-v2-smoke-$VERSION-$CORRELATION_ID")"
  if [[ "$smoke_artifact_present" == true ]]; then
    SMOKE_WARNING=true
    printf '\nWARNING: GitHub hosted GUI smoke failed. The installer is a test artifact and must be launched manually on Windows.\n'
  fi
  upgrade_artifact_present="$(printf '%s' "$artifacts_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const artifacts = JSON.parse(input).artifacts || [];
      process.stdout.write(artifacts.some((artifact) => artifact.name === name) ? "true" : "false");
    });
  ' "cr-tools-v2-upgrade-$VERSION-$CORRELATION_ID")"
  if [[ "$upgrade_artifact_present" == true ]]; then
    SMOKE_WARNING=true
    printf '\nWARNING: GitHub hosted install-over-existing check failed. Perform a manual upgrade before release.\n'
  fi
fi

artifact_zip="$TMP_DIR/artifact.zip"
extract_dir="$TMP_DIR/artifact"
mkdir -p -- "$extract_dir"
info 'Downloading the verified Windows artifact'
github_download "/repos/$REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" "$artifact_zip"
unzip -q "$artifact_zip" -d "$extract_dir"

ARTIFACT_NAME="CR_Tools_V2_Setup_$VERSION.exe"
shopt -s globstar nullglob
installer_matches=("$extract_dir"/**/"$ARTIFACT_NAME")
(( ${#installer_matches[@]} == 1 )) || die "Expected exactly one $ARTIFACT_NAME in the workflow artifact."

destination="$PUBLISH_ROOT/$VERSION/run-$RUN_ID"
[[ ! -e "$destination" ]] || die "Published output already exists: $destination"
mkdir -p -- "$destination"
install -m 0644 "${installer_matches[0]}" "$destination/$ARTIFACT_NAME"
inventory_matches=("$extract_dir"/**/runtime-integrity.json)
if (( ${#inventory_matches[@]} == 1 )); then
  install -m 0644 "${inventory_matches[0]}" "$destination/runtime-integrity.json"
fi
if [[ "$MODE" == release ]]; then
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    'https://updates.artcsworld.xyz/downloads/v2/manifest.json' \
    --output "$destination/manifest.json"
fi

sha512="$(sha512sum "$destination/$ARTIFACT_NAME" | cut -d ' ' -f 1)"
size="$(stat -c '%s' "$destination/$ARTIFACT_NAME")"

printf '\nBuild completed successfully.\n'
printf 'Mode:      %s\n' "$MODE"
printf 'Version:   %s\n' "$VERSION"
printf 'Installer: %s\n' "$destination/$ARTIFACT_NAME"
printf 'Size:      %s bytes\n' "$size"
printf 'SHA-512:   %s\n' "$sha512"
printf 'Workflow:  %s\n' "$RUN_URL"
if [[ "$MODE" == release ]]; then
  printf 'Public URL: https://updates.artcsworld.xyz/downloads/v2/%s\n' "$ARTIFACT_NAME"
else
  printf 'Production deployment was not performed.\n'
fi
if [[ "$SMOKE_WARNING" == true ]]; then
  printf 'Manual gate: Install and launch this build on a real Windows desktop before release.\n'
fi
if [[ "$WORKFLOW_WARNING" == true ]]; then
  printf 'Workflow note: GitHub reported a post-build failure, but the complete installer artifact was recovered.\n'
fi
