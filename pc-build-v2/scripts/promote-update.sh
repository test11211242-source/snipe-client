#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

DIRECTORY=''
VERSION=''
ARTIFACT_NAME=''
ARTIFACT_SHA512_HEX=''
STAGING_ID=''
PHASE=''
BOOTSTRAP=false
FAILPOINT="${CR_TOOLS_PROMOTION_FAILPOINT:-}"

while (($# > 0)); do
  case "$1" in
    --directory | --version | --artifact-name | --artifact-sha512-hex | --staging-id | --phase)
      (($# >= 2)) || die "Missing value for $1"
      case "$1" in
        --directory) DIRECTORY="$2" ;;
        --version) VERSION="$2" ;;
        --artifact-name) ARTIFACT_NAME="$2" ;;
        --artifact-sha512-hex) ARTIFACT_SHA512_HEX="$2" ;;
        --staging-id) STAGING_ID="$2" ;;
        --phase) PHASE="$2" ;;
      esac
      shift 2
      ;;
    --bootstrap)
      BOOTSTRAP=true
      shift
      ;;
    *) die "Unknown promotion argument: $1" ;;
  esac
done

[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die 'Version must be strict x.y.z semver.'
((${#VERSION} <= 32)) || die 'Version is too long.'
[[ "$ARTIFACT_NAME" == "CR_Tools_V2_Setup_$VERSION.exe" ]] ||
  die 'Artifact name does not match the version.'
[[ "$ARTIFACT_SHA512_HEX" =~ ^[0-9a-f]{128}$ ]] || die 'Invalid SHA-512 hex value.'
[[ "$STAGING_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
  die 'Invalid staging ID.'
[[ "$PHASE" == prepare || "$PHASE" == commit ]] || die 'Phase must be prepare or commit.'
[[ -z "$FAILPOINT" || "$FAILPOINT" == after-manifest ]] || die 'Unknown promotion failpoint.'
[[ -d "$DIRECTORY" ]] || die 'Promotion directory does not exist.'
command -v flock >/dev/null 2>&1 || die 'flock is required.'
command -v python3 >/dev/null 2>&1 || die 'python3 is required.'
command -v sha512sum >/dev/null 2>&1 || die 'sha512sum is required.'

staged_artifact="$DIRECTORY/$ARTIFACT_NAME.new.$STAGING_ID"
staged_manifest="$DIRECTORY/manifest.json.new.$STAGING_ID"
prepared_manifest="$DIRECTORY/.manifest.json.ready.$STAGING_ID"
current_manifest="$DIRECTORY/manifest.json"
final_artifact="$DIRECTORY/$ARTIFACT_NAME"
high_water="$DIRECTORY/.high-water.v1.json"
base_fixture="$DIRECTORY/CR_Tools_V2_Setup_0.1.18.exe"
base_fixture_size='159201176'
base_fixture_sha512='d2a2d50b7c2aada8d9ddd47e23520d2d49516b534d471c4c2237445eeb9495664daa1c4be68f3150e34c098632304de09d7ac2308cf3ea608ed43603d7d37bc4'

cleanup() {
  rm -f -- "$staged_artifact" "$staged_manifest"
}
trap cleanup EXIT

manifest_fields() {
  python3 - "$1" <<'PY'
import base64
import hashlib
import json
import re
import sys
from datetime import datetime

path = sys.argv[1]
with open(path, 'rb') as manifest_file:
    source = manifest_file.read(128 * 1024 + 1)
if len(source) > 128 * 1024:
    raise SystemExit('Manifest is too large')

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate manifest key')
        value[key] = item
    return value

manifest = json.loads(source.decode('utf-8'), object_pairs_hook=unique_object)
if not isinstance(manifest, dict):
    raise SystemExit('Manifest shape is invalid')
required = {'schemaVersion', 'channel', 'version', 'publishedAt', 'critical', 'notes', 'artifact', 'signature'}
optional = {'minimumVersion'}
if not required.issubset(manifest) or not set(manifest).issubset(required | optional):
    raise SystemExit('Manifest fields are invalid')
if manifest['schemaVersion'] != 1 or manifest['channel'] != 'stable':
    raise SystemExit('Manifest channel or schema is invalid')
semver = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
version = manifest['version']
if not isinstance(version, str) or len(version) > 32 or semver.fullmatch(version) is None:
    raise SystemExit('Manifest version is invalid')
if 'minimumVersion' in manifest:
    minimum = manifest['minimumVersion']
    if not isinstance(minimum, str) or len(minimum) > 32 or semver.fullmatch(minimum) is None:
        raise SystemExit('Manifest minimum version is invalid')
published_at = manifest['publishedAt']
timestamp_pattern = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})')
if not isinstance(published_at, str) or timestamp_pattern.fullmatch(published_at) is None:
    raise SystemExit('Manifest publication time is invalid')
try:
    timestamp = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
except ValueError as error:
    raise SystemExit('Manifest publication time is invalid') from error
if timestamp.tzinfo is None:
    raise SystemExit('Manifest publication time requires an offset')
if not isinstance(manifest['critical'], bool):
    raise SystemExit('Manifest critical flag is invalid')
notes = manifest['notes']
if not isinstance(notes, list) or len(notes) > 20 or any(not isinstance(note, str) or not 1 <= len(note) <= 1000 for note in notes):
    raise SystemExit('Manifest notes are invalid')

artifact = manifest['artifact']
if not isinstance(artifact, dict) or set(artifact) != {'fileName', 'size', 'sha512', 'url'}:
    raise SystemExit('Manifest artifact fields are invalid')
file_name = artifact['fileName']
expected_name = f'CR_Tools_V2_Setup_{version}.exe'
if file_name != expected_name:
    raise SystemExit('Manifest artifact name is invalid')
if artifact['url'] != f'https://updates.artcsworld.xyz/downloads/v2/{expected_name}':
    raise SystemExit('Manifest artifact URL is invalid')
size = artifact['size']
if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 500 * 1024 * 1024:
    raise SystemExit('Manifest artifact size is invalid')

def canonical_base64(value, length, label):
    if not isinstance(value, str):
        raise SystemExit(f'Manifest {label} is invalid')
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as error:
        raise SystemExit(f'Manifest {label} is invalid') from error
    if len(decoded) != length or base64.b64encode(decoded).decode('ascii') != value:
        raise SystemExit(f'Manifest {label} is invalid')
    return decoded

decoded_hash = canonical_base64(artifact['sha512'], 64, 'artifact hash')
canonical_base64(manifest['signature'], 64, 'signature')
print(version)
print(file_name)
print(decoded_hash.hex())
print(size)
print(hashlib.sha512(source).hexdigest())
PY
}

high_water_fields() {
  python3 - "$1" <<'PY'
import json
import re
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as source:
    value = json.load(source)
if not isinstance(value, dict) or set(value) != {'version', 'manifestSha512'}:
    raise SystemExit('High-water record is invalid')
if not isinstance(value['version'], str) or re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value['version']) is None:
    raise SystemExit('High-water version is invalid')
if not isinstance(value['manifestSha512'], str) or re.fullmatch(r'[0-9a-f]{128}', value['manifestSha512']) is None:
    raise SystemExit('High-water manifest digest is invalid')
print(value['version'])
print(value['manifestSha512'])
PY
}

compare_versions() {
  python3 - "$1" "$2" <<'PY'
import sys
left, right = (tuple(map(int, value.split('.'))) for value in sys.argv[1:])
print((left > right) - (left < right), end='')
PY
}

write_high_water() {
  local version="$1"
  local digest="$2"
  local temporary="$high_water.new.$STAGING_ID"
  printf '{"version":"%s","manifestSha512":"%s"}\n' "$version" "$digest" >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$high_water"
}

verify_artifact() {
  local path="$1"
  local size="$2"
  [[ -f "$path" && "$(stat -c '%s' "$path")" == "$size" ]] ||
    die 'Artifact size does not match its manifest.'
  [[ "$(sha512sum "$path" | cut -d ' ' -f 1)" == "$ARTIFACT_SHA512_HEX" ]] ||
    die 'Artifact hash verification failed.'
}

exec 9>"$DIRECTORY/.publish.lock"
flock -x 9
chmod 755 "$DIRECTORY"

if [[ "$PHASE" == prepare ]]; then
  [[ -f "$staged_artifact" && -f "$staged_manifest" ]] ||
    die 'Both staged release files are required for prepare.'
  incoming_manifest="$staged_manifest"
  incoming_artifact="$staged_artifact"
else
  [[ -f "$prepared_manifest" && -f "$final_artifact" ]] ||
    die 'Prepared manifest and public artifact are required for commit.'
  incoming_manifest="$prepared_manifest"
  incoming_artifact="$final_artifact"
fi

mapfile -t incoming_fields < <(manifest_fields "$incoming_manifest")
((${#incoming_fields[@]} == 5)) || die 'Incoming manifest fields are incomplete.'
[[ "${incoming_fields[0]}" == "$VERSION" && "${incoming_fields[1]}" == "$ARTIFACT_NAME" ]] ||
  die 'Incoming manifest does not match the requested release.'
[[ "${incoming_fields[2]}" == "$ARTIFACT_SHA512_HEX" ]] ||
  die 'Incoming manifest hash does not match the requested release.'
verify_artifact "$incoming_artifact" "${incoming_fields[3]}"

current_fields=()
water_fields=()
if [[ -f "$current_manifest" ]]; then
  mapfile -t current_fields < <(manifest_fields "$current_manifest")
  ((${#current_fields[@]} == 5)) || die 'Current manifest fields are incomplete.'
fi
if [[ -f "$high_water" ]]; then
  mapfile -t water_fields < <(high_water_fields "$high_water")
  ((${#water_fields[@]} == 2)) || die 'High-water record is incomplete.'
  ((${#current_fields[@]} == 5)) || die 'High-water record exists but current manifest is missing.'
  if [[ "${water_fields[0]}" != "${current_fields[0]}" || "${water_fields[1]}" != "${current_fields[4]}" ]]; then
    recovered=false
    shopt -s nullglob
    for recovery_manifest in "$DIRECTORY"/.manifest.json.ready.*; do
      recovery_fields=()
      mapfile -t recovery_fields < <(manifest_fields "$recovery_manifest")
      if ((${#recovery_fields[@]} == 5)) &&
        [[ "${recovery_fields[0]}" == "${current_fields[0]}" && "${recovery_fields[4]}" == "${current_fields[4]}" ]]; then
        recovery_artifact="$DIRECTORY/${current_fields[1]}"
        [[ -f "$recovery_artifact" && "$(stat -c '%s' "$recovery_artifact")" == "${current_fields[3]}" ]] ||
          die 'Interrupted commit artifact is missing or has the wrong size.'
        [[ "$(sha512sum "$recovery_artifact" | cut -d ' ' -f 1)" == "${current_fields[2]}" ]] ||
          die 'Interrupted commit artifact has the wrong hash.'
        write_high_water "${current_fields[0]}" "${current_fields[4]}"
        rm -f -- "$recovery_manifest"
        water_fields=("${current_fields[0]}" "${current_fields[4]}")
        recovered=true
        break
      fi
    done
    shopt -u nullglob
    [[ "$recovered" == true ]] ||
      die 'Current manifest conflicts with the durable high-water record.'
  fi
fi

if ((${#current_fields[@]} == 5)); then
  [[ "$BOOTSTRAP" == false ]] || die 'Bootstrap is not allowed when a manifest exists.'
  comparison="$(compare_versions "$VERSION" "${current_fields[0]}")"
  ((comparison >= 0)) || die "Release $VERSION is older than current ${current_fields[0]}."
  if ((comparison == 0)); then
    [[ "${incoming_fields[4]}" == "${current_fields[4]}" ]] ||
      die 'Same-version manifest content conflicts with the current release.'
    verify_artifact "$final_artifact" "${current_fields[3]}"
    if ((${#water_fields[@]} == 0)); then
      write_high_water "${current_fields[0]}" "${current_fields[4]}"
    fi
    rm -f -- "$prepared_manifest"
    printf 'ALREADY_CURRENT\n'
    exit 0
  fi
else
  [[ "$BOOTSTRAP" == true ]] || die 'No current manifest exists; explicit bootstrap is required.'
  ((${#water_fields[@]} == 0)) || die 'Bootstrap cannot reset an existing high-water record.'
  shopt -s nullglob
  for existing_artifact in "$DIRECTORY"/CR_Tools_V2_Setup_*.exe; do
    if [[ "$existing_artifact" == "$final_artifact" ]]; then
      continue
    fi
    if [[ "$existing_artifact" == "$base_fixture" ]] &&
      [[ "$(stat -c '%s' "$base_fixture")" == "$base_fixture_size" ]] &&
      [[ "$(sha512sum "$base_fixture" | cut -d ' ' -f 1)" == "$base_fixture_sha512" ]]; then
      continue
    fi
    die 'Bootstrap is not allowed while a previous release artifact exists.'
  done
  shopt -u nullglob
fi

if [[ "$PHASE" == prepare ]]; then
  if [[ -e "$final_artifact" ]]; then
    verify_artifact "$final_artifact" "${incoming_fields[3]}"
    rm -f -- "$staged_artifact"
  else
    mv -- "$staged_artifact" "$final_artifact"
  fi
  chmod 644 "$final_artifact"
  rm -f -- "$prepared_manifest"
  mv -- "$staged_manifest" "$prepared_manifest"
  chmod 600 "$prepared_manifest"
  printf 'PREPARED\n'
  exit 0
fi

commit_manifest="$DIRECTORY/.manifest.json.commit.$STAGING_ID"
cp -- "$prepared_manifest" "$commit_manifest"
chmod 644 "$commit_manifest"
mv -- "$commit_manifest" "$current_manifest"
if [[ "$FAILPOINT" == after-manifest ]]; then
  die 'Injected failure after manifest commit.'
fi
write_high_water "$VERSION" "${incoming_fields[4]}"
rm -f -- "$prepared_manifest"
printf 'PROMOTED\n'
