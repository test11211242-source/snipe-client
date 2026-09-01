#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$SCRIPT_DIR/../../publish-update.sh"
WORKFLOW="$SCRIPT_DIR/../../../.github/workflows/pc-build-v2-release.yml"

deploy_condition="inputs.deploy == true && github.ref == 'refs/heads/main'"
deploy_condition_count=0
stable_update_root="/home/ubuntu/snipe-shared/data/updates/downloads/v2"
stable_update_root_count=0
while IFS= read -r line; do
  [[ "$line" != *"inputs.deploy == 'true'"* ]]
  [[ "$line" != *"/home/ubuntu/snipe/data/updates/downloads/v2"* ]]
  if [[ "$line" == *"$deploy_condition"* ]]; then
    deploy_condition_count=$((deploy_condition_count + 1))
  fi
  if [[ "$line" == *"$stable_update_root"* ]]; then
    stable_update_root_count=$((stable_update_root_count + 1))
  fi
done <"$WORKFLOW"
[[ "$deploy_condition_count" -eq 2 ]]
[[ "$stable_update_root_count" -eq 1 ]]

output="$($PUBLISHER release --plan)"
value() {
  local label="$1"
  while IFS= read -r line; do
    if [[ "$line" == "$label: "* ]]; then
      printf '%s' "${line#*: }"
      return
    fi
  done <<<"$output"
  return 1
}

mode="$(value Mode)"
package_version="$(value 'Package version')"
published_version="$(value 'Published version')"
selected_version="$(value 'Selected version')"
bootstrap="$(value Bootstrap)"

[[ "$mode" == release ]]
for version in "$package_version" "$selected_version"; do
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
done

comparison="$(node -e '
  const [left, right] = process.argv.slice(1).map((value) => value.split(".").map(BigInt));
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      process.stdout.write(left[index] > right[index] ? "1" : "-1");
      process.exit(0);
    }
  }
  process.stdout.write("0");
' "$selected_version" "$package_version")"
((comparison >= 0))

if [[ "$published_version" == none ]]; then
  [[ "$bootstrap" == true ]]
  [[ "$selected_version" == "$package_version" ]]
else
  [[ "$published_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
  [[ "$bootstrap" == false ]]
fi

printf 'Publisher plan tests passed.\n'
