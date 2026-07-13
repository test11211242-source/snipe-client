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
ASSUME_YES=false

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
  ./publish-update.sh release [x.y.z] [--critical] [--yes]

Modes:
  test     Build and download a Windows installer without production deployment.
  release  Build, sign, deploy, and verify a production update.

Authentication:
  Set GH_TOKEN/GITHUB_TOKEN, or create ~/.config/cr-tools-v2/publisher.env
  with GH_TOKEN=... and chmod 600. Required repository permissions are
  Contents write, Actions write, and Workflows write. The old pc-build/.env
  is never read.
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
    --yes | -y)
      ASSUME_YES=true
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
  printf '\nSelect build mode:\n'
  printf '  [1] test    Build and download only (recommended)\n'
  printf '  [2] release Build, sign, and publish to users\n'
  read -r -p 'Choice [1]: ' mode_choice
  case "${mode_choice:-1}" in
    1) MODE=test ;;
    2) MODE=release ;;
    *) die 'Invalid build mode.' ;;
  esac
fi

[[ "$MODE" == release || "$CRITICAL" == false ]] || die '--critical requires release mode.'

require_command git
require_command node
require_command npm
require_command python3
require_command curl
require_command unzip
require_command sha512sum
require_command stat
require_command install

cd "$SCRIPT_DIR"
CURRENT_VERSION="$(node -p "require('./package.json').version")"
[[ "$CURRENT_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die "package.json contains an invalid version: $CURRENT_VERSION"

if [[ -z "$VERSION" ]]; then
  IFS='.' read -r major minor patch <<<"$CURRENT_VERSION"
  patch_version="$major.$minor.$((patch + 1))"
  minor_version="$major.$((minor + 1)).0"
  major_version="$((major + 1)).0.0"
  if [[ -t 0 ]]; then
    printf '\nCurrent version: %s\n' "$CURRENT_VERSION"
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

[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die "Version must use strict x.y.z semver: $VERSION"

comparison="$(node -e '
  const [left, right] = process.argv.slice(1).map((value) => value.split(".").map(Number));
  let result = 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) { result = Math.sign(left[i] - right[i]); break; }
  }
  process.stdout.write(String(result));
' "$VERSION" "$CURRENT_VERSION")"
[[ "$comparison" -ge 0 ]] || die 'Build version cannot be lower than package.json.'

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
  printf 'Required repository permissions: Contents write, Actions write, Workflows write.\n'
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

git -C "$REPO_ROOT" diff --cached --quiet ||
  die 'The git index already contains staged changes. Commit or unstage them first.'
git -C "$REPO_ROOT" config user.name >/dev/null || die 'git user.name is not configured.'
git -C "$REPO_ROOT" config user.email >/dev/null || die 'git user.email is not configured.'

if [[ "$MODE" == release && "$ASSUME_YES" == false ]]; then
  printf '\nWARNING: release mode publishes an update to production users.\n'
  read -r -p 'Type PUBLISH to continue: ' confirmation
  [[ "$confirmation" == PUBLISH ]] || die 'Production publication was cancelled.'
elif [[ "$MODE" == test && "$ASSUME_YES" == false ]]; then
  read -r -p "Build test version $VERSION and commit/push V2 changes? [Y/n]: " confirmation
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

info 'Validating GitHub repository access'
repository_json="$(github_api GET "/repos/$REPOSITORY")"
can_push="$(printf '%s' "$repository_json" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const repository = JSON.parse(input);
    process.stdout.write(repository.permissions?.push === true ? "true" : "false");
  });
')"
[[ "$can_push" == true ]] || die 'GitHub token does not have Contents write access to this repository.'

if [[ "$MODE" == release ]]; then
  published_manifest="$TMP_DIR/published-manifest.json"
  if curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    'https://updates.artcsworld.xyz/downloads/v2/manifest.json' \
    --output "$published_manifest"; then
    published_version="$(node -e '
      const fs = require("fs");
      try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || "")); }
      catch { process.exit(2); }
    ' "$published_manifest")" || die 'Published manifest could not be parsed.'
    if [[ -n "$published_version" ]]; then
      newer="$(node -e '
        const values = process.argv.slice(1).map((value) => value.split(".").map(Number));
        let result = 0;
        for (let i = 0; i < 3; i += 1) {
          if (values[0][i] !== values[1][i]) { result = Math.sign(values[0][i] - values[1][i]); break; }
        }
        process.stdout.write(String(result));
      ' "$VERSION" "$published_version")"
      [[ "$newer" -gt 0 ]] || die "Release $VERSION must be newer than published $published_version."
    fi
  fi
fi

info "Preparing CR Tools V2 $VERSION ($MODE)"
info 'Installing deterministic Node dependencies'
npm ci

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
npm test
(
  cd python
  "$PYTHON_CACHE/bin/python" -m pytest tests
)
npm audit --audit-level=high
npm run build:app

info "Setting package version to $VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

RELEASE_PATHS=(
  'pc-build-v2'
  '.github/workflows/pc-build-v2-release.yml'
  'docs/CR_TOOLS_V2_IMPLEMENTATION_PLAN.md'
)

info 'Staging only reviewed V2 release paths'
git -C "$REPO_ROOT" add -- "${RELEASE_PATHS[@]}"
mapfile -d '' staged_files < <(git -C "$REPO_ROOT" diff --cached --name-only -z)
for staged_file in "${staged_files[@]}"; do
  case "$staged_file" in
    *.env | *.env.* | *.pfx | *.p12 | *.key | *private*.pem)
      git -C "$REPO_ROOT" reset -q -- "${RELEASE_PATHS[@]}"
      die "Sensitive file was selected for commit: $staged_file"
      ;;
  esac
done

if ((${#staged_files[@]} > 0)); then
  printf 'Files selected for commit:\n'
  printf '  %s\n' "${staged_files[@]}"
  git -C "$REPO_ROOT" commit -m "release: prepare CR Tools V2 $VERSION"
else
  info 'No new source changes; rebuilding the current commit'
fi

ASKPASS="$TMP_DIR/git-askpass.sh"
cat >"$ASKPASS" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
EOF
chmod 700 "$ASKPASS"

info "Pushing $BRANCH to GitHub"
GH_TOKEN="$TOKEN" \
  GIT_ASKPASS="$ASKPASS" \
  GIT_ASKPASS_REQUIRE=force \
  GIT_TERMINAL_PROMPT=0 \
  git -C "$REPO_ROOT" push origin "$BRANCH"

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
runs_path="/repos/$REPOSITORY/actions/workflows/$WORKFLOW_FILE/runs?event=workflow_dispatch&branch=$BRANCH&per_page=20"
before_runs=""
workflow_registered=false
for registration_attempt in {1..30}; do
  if before_runs="$(github_api GET "$runs_path" '' true)"; then
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
before_ids="$(printf '%s' "$before_runs" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const runs = JSON.parse(input).workflow_runs || [];
    process.stdout.write(runs.map((run) => run.id).join(","));
  });
')"

dispatch_body="$(node -e '
  const [ref, version, deploy, critical] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    ref,
    inputs: { version, deploy: deploy === "true", critical: critical === "true" },
  }));
' "$BRANCH" "$VERSION" "$([[ "$MODE" == release ]] && printf true || printf false)" "$CRITICAL")"

info 'Dispatching the Windows workflow'
github_api POST "/repos/$REPOSITORY/actions/workflows/$WORKFLOW_FILE/dispatches" "$dispatch_body" >/dev/null

RUN_ID=""
for _ in {1..30}; do
  sleep 2
  runs="$(github_api GET "$runs_path")"
  RUN_ID="$(printf '%s' "$runs" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const [sha, excludedText] = process.argv.slice(1);
      const excluded = new Set(excludedText.split(",").filter(Boolean).map(Number));
      const runs = JSON.parse(input).workflow_runs || [];
      const match = runs.find((run) => run.head_sha === sha && !excluded.has(run.id));
      if (match) process.stdout.write(String(match.id));
    });
  ' "$HEAD_SHA" "$before_ids")"
  [[ -z "$RUN_ID" ]] || break
done
[[ -n "$RUN_ID" ]] || die 'The dispatched workflow run could not be identified.'

RUN_URL="https://github.com/$REPOSITORY/actions/runs/$RUN_ID"
info "Waiting for Windows build $RUN_ID"
printf 'Run: %s\n' "$RUN_URL"

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
    [[ "$run_conclusion" == success ]] || die "Windows workflow failed: $RUN_URL"
    break
  fi
  ((attempt < 360)) || die "Timed out waiting for Windows workflow: $RUN_URL"
  sleep 10
done

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
' "cr-tools-v2-$VERSION")"
[[ -n "$ARTIFACT_ID" ]] || die 'Windows installer artifact was not found.'

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
