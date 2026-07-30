#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROMOTER="$SCRIPT_DIR/../promote-update.sh"
TEST_ROOT="$(mktemp -d)"
STAGING_ID='29d970c1-fc4f-4bea-a767-8f108d3b8739'

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

stage_release() {
  local version="$1"
  local content="$2"
  local artifact_name="CR_Tools_V2_Setup_$version.exe"
  local artifact="$TEST_ROOT/$artifact_name.new.$STAGING_ID"
  local manifest="$TEST_ROOT/manifest.json.new.$STAGING_ID"
  printf '%s' "$content" >"$artifact"
  python3 - "$version" "$artifact_name" "$artifact" "$manifest" <<'PY'
import base64
import hashlib
import json
import sys

version, name, artifact_path, manifest_path = sys.argv[1:]
with open(artifact_path, 'rb') as artifact_file:
    content = artifact_file.read()
manifest = {
    'schemaVersion': 1,
    'channel': 'stable',
    'version': version,
    'publishedAt': '2026-07-29T12:00:00.000Z',
    'critical': False,
    'notes': ['Promotion test'],
    'artifact': {
        'fileName': name,
        'size': len(content),
        'sha512': base64.b64encode(hashlib.sha512(content).digest()).decode('ascii'),
        'url': f'https://updates.artcsworld.xyz/downloads/v2/{name}',
    },
    'signature': base64.b64encode(bytes(64)).decode('ascii'),
}
with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
    json.dump(manifest, manifest_file, separators=(',', ':'))
    manifest_file.write('\n')
PY
}

promote() {
  local phase="$1"
  local version="$2"
  local content="$3"
  shift 3
  local hash
  hash="$(printf '%s' "$content" | sha512sum | cut -d ' ' -f 1)"
  CR_TOOLS_PROMOTION_FAILPOINT="${CR_TOOLS_PROMOTION_FAILPOINT:-}" "$PROMOTER" \
    --directory "$TEST_ROOT" \
    --version "$version" \
    --artifact-name "CR_Tools_V2_Setup_$version.exe" \
    --artifact-sha512-hex "$hash" \
    --staging-id "$STAGING_ID" \
    --phase "$phase" \
    "$@"
}

stage_release '1.0.0' 'first'
if promote prepare '1.0.0' 'first' >/dev/null 2>&1; then
  printf 'Expected missing-manifest promotion to require bootstrap.\n' >&2
  exit 1
fi

stage_release '1.0.0' 'first'
python3 - "$TEST_ROOT/manifest.json.new.$STAGING_ID" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as source:
    value = json.load(source)
del value['signature']
with open(path, 'w', encoding='utf-8') as destination:
    json.dump(value, destination)
PY
if promote prepare '1.0.0' 'first' --bootstrap >/dev/null 2>&1; then
  printf 'Expected an incomplete schema-v1 manifest to fail.\n' >&2
  exit 1
fi

stage_release '1.0.0' 'first'
[[ "$(promote prepare '1.0.0' 'first' --bootstrap)" == 'PREPARED' ]]
[[ ! -e "$TEST_ROOT/manifest.json" ]]
[[ "$(<"$TEST_ROOT/CR_Tools_V2_Setup_1.0.0.exe")" == 'first' ]]
[[ "$(stat -c '%a' "$TEST_ROOT/CR_Tools_V2_Setup_1.0.0.exe")" == 644 ]]
[[ "$(promote commit '1.0.0' 'first' --bootstrap)" == 'PROMOTED' ]]
[[ "$(stat -c '%a' "$TEST_ROOT/manifest.json")" == 644 ]]
[[ "$(stat -c '%a' "$TEST_ROOT/.high-water.v1.json")" == 600 ]]

stage_release '1.0.0' 'first'
[[ "$(promote prepare '1.0.0' 'first')" == 'ALREADY_CURRENT' ]]

stage_release '1.0.0' 'changed'
if promote prepare '1.0.0' 'changed' >/dev/null 2>&1; then
  printf 'Expected same-version different-hash promotion to fail.\n' >&2
  exit 1
fi
[[ "$(<"$TEST_ROOT/CR_Tools_V2_Setup_1.0.0.exe")" == 'first' ]]

stage_release '1.1.0' 'second'
[[ "$(promote prepare '1.1.0' 'second')" == 'PREPARED' ]]
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$TEST_ROOT/manifest.json")" == '1.0.0' ]]
if CR_TOOLS_PROMOTION_FAILPOINT=after-manifest promote commit '1.1.0' 'second' >/dev/null 2>&1; then
  printf 'Expected the commit failpoint to interrupt promotion.\n' >&2
  exit 1
fi
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$TEST_ROOT/manifest.json")" == '1.1.0' ]]
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$TEST_ROOT/.high-water.v1.json")" == '1.0.0' ]]
[[ "$(promote commit '1.1.0' 'second')" == 'ALREADY_CURRENT' ]]
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$TEST_ROOT/.high-water.v1.json")" == '1.1.0' ]]

stage_release '1.0.1' 'older'
if promote prepare '1.0.1' 'older' >/dev/null 2>&1; then
  printf 'Expected non-monotonic promotion to fail.\n' >&2
  exit 1
fi

rm -f -- "$TEST_ROOT/manifest.json"
stage_release '2.0.0' 'reset-attempt'
if promote prepare '2.0.0' 'reset-attempt' --bootstrap >/dev/null 2>&1; then
  printf 'Expected bootstrap to reject an existing high-water record.\n' >&2
  exit 1
fi

printf 'Promotion helper tests passed.\n'
